//! Pixel dimensions from PNG, JPEG, GIF and WebP headers, read without decoding the image.

fn u16_be(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?).into())
}

fn u16_le(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?).into())
}

fn u24_le(bytes: &[u8], at: usize) -> Option<u32> {
    let b = bytes.get(at..at + 3)?;
    Some(u32::from(b[0]) | (u32::from(b[1]) << 8) | (u32::from(b[2]) << 16))
}

fn u32_be(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn u32_le(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Width and height, or `None` when the header isn't one this knows.
pub(super) fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 {
        return None;
    }
    // PNG: IHDR follows the 8-byte signature.
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some((u32_be(bytes, 16)?, u32_be(bytes, 20)?));
    }
    if bytes.starts_with(b"GIF") {
        return Some((u16_le(bytes, 6)?, u16_le(bytes, 8)?));
    }
    // WebP: lossy (VP8 ), lossless (VP8L) or extended (VP8X).
    if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return match &bytes[12..16] {
            b"VP8 " => Some((u16_le(bytes, 26)? & 0x3fff, u16_le(bytes, 28)? & 0x3fff)),
            b"VP8L" => {
                let bits = u32_le(bytes, 21)?;
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            b"VP8X" => Some((u24_le(bytes, 24)? + 1, u24_le(bytes, 27)? + 1)),
            _ => None,
        };
    }
    // JPEG: walk the segments to the first start-of-frame marker.
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut at = 2;
        while at + 9 < bytes.len() {
            if bytes[at] != 0xff {
                return None;
            }
            let marker = bytes[at + 1];
            let len = u16_be(bytes, at + 2)? as usize;
            let start_of_frame =
                (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker);
            if start_of_frame {
                return Some((u16_be(bytes, at + 7)?, u16_be(bytes, at + 5)?));
            }
            at += 2 + len;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_png_header() {
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&640u32.to_be_bytes());
        png.extend_from_slice(&480u32.to_be_bytes());
        assert_eq!(image_size(&png), Some((640, 480)));
        assert_eq!(image_size(b"not an image at all, honestly"), None);
    }
}
