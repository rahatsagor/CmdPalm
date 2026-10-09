//! Text segmentation for Unicode keyboard events.

/// Apps reliably accept up to 20 UTF-16 units per `CGEventKeyboardSetUnicodeString`
/// event; stay below that.
pub const MAX_UNITS_PER_EVENT: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Text(String),
    Return,
    Tab,
}

/// Split text into Unicode chunks and control keys, never splitting a
/// surrogate pair. `\r\n` and `\r` are treated as a single Return.
pub fn segments(text: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut chunk = String::new();
    let mut units = 0;
    let mut chars = text.chars().peekable();

    let flush = |chunk: &mut String, units: &mut usize, out: &mut Vec<Segment>| {
        if !chunk.is_empty() {
            out.push(Segment::Text(std::mem::take(chunk)));
            *units = 0;
        }
    };

    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                flush(&mut chunk, &mut units, &mut out);
                out.push(Segment::Return);
            }
            '\n' => {
                flush(&mut chunk, &mut units, &mut out);
                out.push(Segment::Return);
            }
            '\t' => {
                flush(&mut chunk, &mut units, &mut out);
                out.push(Segment::Tab);
            }
            c if c.is_control() => {}
            c => {
                let len = c.len_utf16();
                if units + len > MAX_UNITS_PER_EVENT {
                    flush(&mut chunk, &mut units, &mut out);
                }
                chunk.push(c);
                units += len;
            }
        }
    }
    flush(&mut chunk, &mut units, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_into_bounded_chunks_and_control_keys() {
        let segs = segments("hello\r\nworld\tok");
        assert_eq!(
            segs,
            vec![
                Segment::Text("hello".into()),
                Segment::Return,
                Segment::Text("world".into()),
                Segment::Tab,
                Segment::Text("ok".into()),
            ]
        );
    }

    #[test]
    fn never_splits_surrogate_pairs() {
        let text = "😀".repeat(20);
        for seg in segments(&text) {
            let Segment::Text(t) = seg else { panic!() };
            assert!(t.encode_utf16().count() <= MAX_UNITS_PER_EVENT);
            assert!(t.chars().all(|c| c == '😀'));
        }
    }

    #[test]
    fn drops_other_control_characters() {
        assert_eq!(segments("a\u{0007}b"), vec![Segment::Text("ab".into())]);
    }
}
