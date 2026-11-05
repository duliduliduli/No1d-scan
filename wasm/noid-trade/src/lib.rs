// SPDX-License-Identifier: Apache-2.0
//! Authorizes a Parano1d native trade on the user's own device.
//!
//! The node prepares an unsigned plan; this module checks it (chain, parent block,
//! plan identity, the exact request the user asked for, the fee cap), derives the
//! spend secret for the wallet address, and runs the whole owner proof locally:
//! prepare, begin, prove and finish. `finish` runs the chain's own verifier before
//! returning, and the result is verified once more as a complete intent. The secret
//! is never returned, stored or sent anywhere.
//!
//! ABI (no wasm-bindgen): every call returns a pointer to `[status u32][len u32][bytes]`
//! (status 0 = ok, 1 = error message). The caller frees it with `noid_free(ptr, 8 + len)`.
//! Randomness comes from the import `env.noid_random(ptr, len)` (crypto.getRandomValues).

use noid_core::{Block128, TowerField};
use noid_poseidon2b::{
    native::compression::Poseidon2bSponge,
    primitives::{derive_address, SpendSecret},
};
use parano1d_authorization::{native::NativeOperationPlan, prepare, prove_job, verify_intent, WalletOperation};
use zeroize::{Zeroize, Zeroizing};

type Result<T> = std::result::Result<T, String>;

/// Same derivation as the node keystore (noid_node/src/wallet/keystore.rs, Core v2.1.0).
pub fn derive_spend_secret(master: &[u8; 32], index: u32) -> SpendSecret {
    let mut sponge = Poseidon2bSponge::with_iv([Block128::ZERO; 2]);
    let mut fields = Zeroizing::new([
        Block128::from(u128::from_le_bytes(master[..16].try_into().unwrap())),
        Block128::from(u128::from_le_bytes(master[16..].try_into().unwrap())),
    ]);
    sponge.absorb(fields[0]);
    sponge.absorb(fields[1]);
    fields.zeroize();
    sponge.absorb(Block128::from(index as u128));
    sponge.absorb(Block128::from(0x6E6F69642D64657269_u128)); // "noid-deri"
    let mut digest = sponge.finalize();
    let secret = SpendSecret::from_bytes(digest);
    digest.zeroize();
    secret
}

pub fn address(master: &[u8; 32], index: u32) -> String {
    derive_address(&derive_spend_secret(master, index)).to_bech32()
}

fn plan(json: &[u8]) -> Result<NativeOperationPlan> {
    serde_json::from_slice(json).map_err(|e| format!("invalid trade plan: {e}"))
}

/// Checks the plan and returns its review (amounts, fee, minimum output) plus owner and height.
pub fn review(json: &[u8]) -> Result<String> {
    let p = plan(json)?;
    let owner = p.native_plan.owner.clone();
    let height = p.native_plan.candidate_height;
    let mut review = WalletOperation::Native(p).review()?;
    if let Some(obj) = review.as_object_mut() {
        obj.insert("owner".into(), owner.into());
        obj.insert("candidate_height".into(), height.into());
    }
    serde_json::to_string(&review).map_err(|e| e.to_string())
}

/// Proves ownership for the plan and returns the authorized intent as hex.
pub fn authorize(master: &[u8; 32], index: u32, json: &[u8]) -> Result<String> {
    let p = plan(json)?;
    let height = p.native_plan.candidate_height;
    let owner = p.native_plan.owner.clone();
    let secret = derive_spend_secret(master, index);
    if derive_address(&secret).to_bech32() != owner {
        return Err("this plan is for a different address than the unlocked wallet".into());
    }
    let operation = WalletOperation::Native(p);
    operation.review()?; // runs every plan check before any proving starts
    let (request, pending) = prepare(&secret)?.begin(operation)?;
    drop(secret);
    let response = prove_job(&request)?;
    let intent = pending.finish(&response)?;
    verify_intent(&intent, height)?;
    Ok(hex::encode(intent))
}

/// Runs one full owner proof (prepare, begin, prove, finish with the chain verifier)
/// for a random throwaway key and statement. Checks the prover works on this device
/// and how long it takes; it never sees a real key.
pub fn selftest() -> Result<String> {
    use noid_gkr::{
        zk_auth_capsule::ZkAuthCapsuleStateTable,
        zk_authorization::{web3, ZkAuthCapsuleOwnerStatement},
    };
    use noid_poseidon2b::native::domain::{capacity_iv, TAG_ADDRFIX};
    let mut raw = [0u8; 48];
    getrandom::getrandom(&mut raw).map_err(|e| e.to_string())?;
    let secret = SpendSecret::from_bytes(raw[..32].try_into().unwrap());
    let perm = secret.with_exposed_prover_fields(|f| {
        let iv = capacity_iv(TAG_ADDRFIX);
        noid_gkr::evaluate_permutation([f[0], f[1], iv[0], iv[1]])
    });
    let state = ZkAuthCapsuleStateTable::from_permutation_witness(&perm).map_err(|e| format!("{e:?}"))?;
    let address = derive_address(&secret).as_fields();
    let tx_body_hash = [
        Block128::from(u128::from_le_bytes(raw[32..48].try_into().unwrap())),
        Block128::from(u128::from_le_bytes(raw[16..32].try_into().unwrap())),
    ];
    raw.zeroize();
    let prepared = web3::prepare(&state, address).map_err(|e| format!("{e:?}"))?;
    let (request, pending) = prepared
        .begin(ZkAuthCapsuleOwnerStatement { tx_body_hash, address })
        .map_err(|e| format!("{e:?}"))?;
    let response = web3::prove(&request).map_err(|e| format!("{e:?}"))?;
    pending.finish(&response).map_err(|e| format!("{e:?}"))?;
    Ok(format!("{{\"ok\":true,\"request_bytes\":{},\"response_bytes\":{}}}", request.len(), response.len()))
}

// ---- wasm ABI ----

#[cfg(target_arch = "wasm32")]
mod abi {
    use super::*;

    #[link(wasm_import_module = "env")]
    extern "C" {
        fn noid_random(ptr: *mut u8, len: usize);
    }
    fn browser_random(buf: &mut [u8]) -> std::result::Result<(), getrandom::Error> {
        unsafe { noid_random(buf.as_mut_ptr(), buf.len()) };
        Ok(())
    }
    getrandom::register_custom_getrandom!(browser_random);

    #[no_mangle]
    pub extern "C" fn noid_alloc(len: usize) -> *mut u8 {
        let mut v = Vec::<u8>::with_capacity(len.max(1));
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    /// Frees and wipes a buffer from noid_alloc or a result.
    #[no_mangle]
    pub unsafe extern "C" fn noid_free(ptr: *mut u8, len: usize) {
        let mut v = Vec::from_raw_parts(ptr, len, len.max(1));
        v.zeroize();
    }

    unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
        std::slice::from_raw_parts(ptr, len)
    }

    unsafe fn master(ptr: *const u8) -> Zeroizing<[u8; 32]> {
        let mut m = Zeroizing::new([0u8; 32]);
        m.copy_from_slice(bytes(ptr, 32));
        m
    }

    fn out(r: Result<String>) -> *mut u8 {
        let (status, body) = match r {
            Ok(s) => (0u32, s.into_bytes()),
            Err(e) => (1u32, e.into_bytes()),
        };
        let mut v = Vec::with_capacity(8 + body.len());
        v.extend_from_slice(&status.to_le_bytes());
        v.extend_from_slice(&(body.len() as u32).to_le_bytes());
        v.extend_from_slice(&body);
        let mut v = std::mem::ManuallyDrop::new(v.into_boxed_slice());
        v.as_mut_ptr()
    }

    #[no_mangle]
    pub unsafe extern "C" fn noid_trade_address(master_ptr: *const u8, index: u32) -> *mut u8 {
        out(Ok(address(&master(master_ptr), index)))
    }

    #[no_mangle]
    pub extern "C" fn noid_trade_selftest() -> *mut u8 {
        out(selftest())
    }

    #[no_mangle]
    pub unsafe extern "C" fn noid_trade_review(json_ptr: *const u8, json_len: usize) -> *mut u8 {
        out(review(bytes(json_ptr, json_len)))
    }

    #[no_mangle]
    pub unsafe extern "C" fn noid_trade_authorize(master_ptr: *const u8, index: u32, json_ptr: *const u8, json_len: usize) -> *mut u8 {
        out(authorize(&master(master_ptr), index, bytes(json_ptr, json_len)))
    }
}
