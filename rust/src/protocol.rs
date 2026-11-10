//! The MeshCore packet/advert subset needed by the bridge. The original
//! @liamcottle/meshcore.js implementation is the compatibility reference.
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedAdvert {
    pub public_key: String,
    pub timestamp: i64,
    pub name: String,
    pub kind: AdvertKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdvertKind {
    Repeater,
    Room,
    Sensor,
}

/// Returns None for untrusted, truncated, unsupported or unverified packets.
pub fn parse_verified_advert(raw: &[u8]) -> Option<VerifiedAdvert> {
    let header = *raw.first()?;
    if (header >> 2) & 15 != 4 {
        return None;
    }
    let mut offset = 1usize;
    if matches!(header & 3, 0 | 3) {
        offset += 4; // transport codes
    }
    let path_len = *raw.get(offset)? as usize;
    offset += 1 + ((path_len & 63) * ((path_len >> 6) + 1));
    let payload = raw.get(offset..)?;
    if payload.len() < 101 {
        return None;
    }
    let key: [u8; 32] = payload.get(..32)?.try_into().ok()?;
    let timestamp = u32::from_le_bytes(payload.get(32..36)?.try_into().ok()?) as i64;
    let signature = Signature::from_slice(payload.get(36..100)?).ok()?;
    let app = payload.get(100..)?;
    let flags = *app.first()?;
    let kind = match flags & 15 {
        2 => AdvertKind::Repeater,
        3 => AdvertKind::Room,
        4 => AdvertKind::Sensor,
        _ => return None,
    };
    let mut signed = Vec::with_capacity(payload.len() - 64);
    signed.extend_from_slice(&payload[..36]);
    signed.extend_from_slice(app);
    VerifyingKey::from_bytes(&key)
        .ok()?
        .verify(&signed, &signature)
        .ok()?;
    let name_offset = 1
        + if flags & 0x10 != 0 { 8 } else { 0 }
        + if flags & 0x20 != 0 { 2 } else { 0 }
        + if flags & 0x40 != 0 { 2 } else { 0 };
    if name_offset > app.len() {
        return None;
    }
    let public_key = hex::encode(key);
    let name = if flags & 0x80 != 0 {
        String::from_utf8_lossy(&app[name_offset..]).into_owned()
    } else {
        public_key[..8].to_owned()
    };
    Some(VerifiedAdvert {
        public_key,
        timestamp,
        name,
        kind,
    })
}
