//! SHA-256 for the chat archive digest, on the audited `sha2` crate (already pinned for the file
//! hashes); this module only adds the archive's message framing.
//!
//! The archive hash is byte-identical to the server's `archiveHash` (extension/kb/chat-lifecycle.mjs)
//! and the Mac's `ChatArchiveLogic.archiveHash`: for every message, `<utf8 byte length>:<role>` then
//! `<utf8 byte length>:<content>`, hashed in order; the digest of no messages is SHA-256 of "".
//! The standard vectors below pin the crate's output, and the framing test pins the format.

use sha2::Digest;

#[derive(Default)]
pub struct Sha256(sha2::Sha256);

impl Sha256 {
    pub fn new() -> Self {
        Self(sha2::Sha256::new())
    }

    pub fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }

    pub fn finish_hex(self) -> String {
        self.0.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// One (role, content) pair as the archive digest sees it.
    pub fn feed_message(&mut self, role: &str, content: &str) {
        self.update(format!("{}:", role.len()).as_bytes());
        self.update(role.as_bytes());
        self.update(format!("{}:", content.len()).as_bytes());
        self.update(content.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(s: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(s);
        h.finish_hex()
    }

    #[test]
    fn standard_vectors() {
        assert_eq!(sha(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(sha(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
        let million_a = vec![b'a'; 1_000_000];
        assert_eq!(sha(&million_a), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    }

    #[test]
    fn streaming_in_odd_pieces_equals_one_shot() {
        let data: Vec<u8> = (0..1000u32).map(|i| (i * 7 % 251) as u8).collect();
        let mut h = Sha256::new();
        for piece in data.chunks(37) {
            h.update(piece);
        }
        assert_eq!(h.finish_hex(), sha(&data));
    }

    #[test]
    fn an_empty_archive_is_the_digest_of_nothing() {
        assert_eq!(Sha256::new().finish_hex(), sha(b""));
    }

    #[test]
    fn the_message_framing_is_length_prefixed_and_unambiguous() {
        let mut h = Sha256::new();
        h.feed_message("user", "héllo");
        // "4:user" + "6:héllo" (é is two bytes)
        assert_eq!(h.finish_hex(), sha("4:user6:héllo".as_bytes()));
        let (mut a, mut b) = (Sha256::new(), Sha256::new());
        a.feed_message("user", "ab");
        a.feed_message("user", "c");
        b.feed_message("user", "a");
        b.feed_message("user", "bc");
        assert_ne!(a.finish_hex(), b.finish_hex(), "message boundaries are part of the digest");
    }
}
