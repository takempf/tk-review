//! A file's "code shape", the token classes along each line, which the viewer paints instead of its text.

use std::collections::HashSet;
use std::sync::LazyLock;

use super::FileKind;

/// Token classes, in the order the viewer's palette expects.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
enum Token {
    Space = 0,
    Identifier = 1,
    Keyword = 2,
    String = 3,
    Comment = 4,
    Number = 5,
    TypeOrTag = 6,
    Punctuation = 7,
}

static KEYWORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    [
        // TS / JS
        "import export from as default const let var function return if else for while do switch case break continue new class extends implements interface type enum async await yield try catch finally throw typeof instanceof in of void delete this super null undefined true false public private protected readonly static abstract declare namespace module keyof infer satisfies get set",
        // Python
        "def lambda pass raise with elif not and or is None True False self global nonlocal assert del print",
        // SQL
        "SELECT FROM WHERE INSERT INTO UPDATE DELETE CREATE TABLE ALTER ADD DROP INDEX ON AND OR NOT NULL PRIMARY KEY REFERENCES BEGIN COMMIT IF EXISTS RETURNS FUNCTION GRANT POLICY USING JOIN LEFT GROUP BY ORDER LIMIT VALUES SET AS WITH CONSTRAINT DEFAULT UNIQUE CASCADE TRIGGER",
        "select from where insert into update delete create table alter add drop index on and or not null primary key references begin commit",
        // shell
        "then fi echo export local",
    ]
    .iter()
    .flat_map(|words| words.split(' '))
    .collect()
});

/// Columns past this are cut off; the minimap is 120 wide.
const MAX_COLUMNS: usize = 120;
/// Files longer than this are sampled down to this many rows.
const MAX_ROWS: usize = 4000;

/// Where a run of text is still open at the end of a line.
enum Open {
    BlockComment,
    String(Vec<char>),
}

/// The lexer's dialect, picked from the file kind.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Dialect {
    Script,
    Tsx,
    Python,
    Shell,
    Yaml,
    Sql,
    Css,
    Svg,
    Other,
}

impl Dialect {
    fn of(kind: FileKind) -> Self {
        match kind {
            FileKind::Ts | FileKind::Dts | FileKind::Js | FileKind::Json => Self::Script,
            FileKind::Tsx => Self::Tsx,
            FileKind::Py => Self::Python,
            FileKind::Sh => Self::Shell,
            FileKind::Yml => Self::Yaml,
            FileKind::Sql => Self::Sql,
            FileKind::Css => Self::Css,
            FileKind::Svg => Self::Svg,
            FileKind::Image | FileKind::Other => Self::Other,
        }
    }
}

const fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn starts_with(line: &[char], at: usize, needle: &[char]) -> bool {
    line.get(at..at + needle.len()) == Some(needle)
}

fn find(line: &[char], from: usize, needle: &[char]) -> Option<usize> {
    (from..line.len()).find(|&at| starts_with(line, at, needle))
}

struct Row(Vec<(Token, usize)>);

impl Row {
    fn push(&mut self, token: Token, len: usize) {
        if len == 0 {
            return;
        }
        match self.0.last_mut() {
            Some((last, total)) if *last == token => *total += len,
            _ => self.0.push((token, len)),
        }
    }
}

/// A line as the viewer lays it out, so its text lines up with its shape: tabs as two spaces, cut at `MAX_COLUMNS`.
pub(super) fn display_columns(raw: &str) -> Vec<char> {
    let raw = raw.strip_suffix('\r').unwrap_or(raw);
    let mut line: Vec<char> = Vec::with_capacity(MAX_COLUMNS + 1);
    for c in raw.chars() {
        if line.len() >= MAX_COLUMNS {
            break;
        }
        if c == '\t' {
            line.extend([' ', ' ']);
        } else {
            line.push(c);
        }
    }
    line.truncate(MAX_COLUMNS);
    while line.last().is_some_and(|c| c.is_whitespace()) {
        line.pop();
    }
    line
}

pub(super) fn display_line(raw: &str) -> String {
    display_columns(raw).into_iter().collect()
}

fn lex(text: &str, dialect: Dialect) -> Vec<Row> {
    let hash_comments = matches!(dialect, Dialect::Python | Dialect::Shell | Dialect::Yaml);
    let css = dialect == Dialect::Css;
    let mut open: Option<Open> = None;
    let mut rows = Vec::new();

    for raw in text.split('\n') {
        let line = display_columns(raw);
        let n = line.len();
        let mut row = Row(Vec::new());
        let mut i = 0;

        while i < n {
            match &open {
                Some(Open::BlockComment) => {
                    match find(&line, i, &['*', '/']) {
                        Some(end) => {
                            row.push(Token::Comment, end + 2 - i);
                            i = end + 2;
                            open = None;
                        }
                        None => {
                            row.push(Token::Comment, n - i);
                            i = n;
                        }
                    }
                    continue;
                }
                Some(Open::String(quote)) => {
                    let quote = quote.clone();
                    let mut j = i;
                    while j < n {
                        if line[j] == '\\' {
                            j += 2;
                            continue;
                        }
                        if starts_with(&line, j, &quote) {
                            j += quote.len();
                            open = None;
                            break;
                        }
                        j += 1;
                    }
                    let end = j.min(n);
                    row.push(Token::String, end - i);
                    i = end;
                    continue;
                }
                None => {}
            }

            let c = line[i];
            let next = line.get(i + 1).copied();
            if c == ' ' {
                let mut j = i;
                while j < n && line[j] == ' ' {
                    j += 1;
                }
                row.push(Token::Space, j - i);
                i = j;
                continue;
            }

            if dialect == Dialect::Svg {
                let mut j = i + 1;
                if c == '<' {
                    while j < n && (is_word(line[j]) || ":/!?-".contains(line[j])) {
                        j += 1;
                    }
                    row.push(Token::TypeOrTag, j - i);
                } else if c == '"' {
                    j = find(&line, i + 1, &['"']).map_or(n, |close| close + 1);
                    row.push(Token::String, j - i);
                } else {
                    j = i;
                    while j < n && !" <\"".contains(line[j]) {
                        j += 1;
                    }
                    j = j.max(i + 1);
                    let token = if j == i + 1 && !is_word(c) {
                        Token::Punctuation
                    } else {
                        Token::Identifier
                    };
                    row.push(token, j - i);
                }
                i = j;
                continue;
            }

            let line_comment = (c == '/' && next == Some('/') && !hash_comments)
                || (c == '#' && hash_comments)
                || (dialect == Dialect::Sql && c == '-' && next == Some('-'));
            if line_comment {
                row.push(Token::Comment, n - i);
                i = n;
                continue;
            }
            if c == '/' && next == Some('*') {
                open = Some(Open::BlockComment);
                row.push(Token::Comment, 2);
                i += 2;
                continue;
            }
            if dialect == Dialect::Python
                && (starts_with(&line, i, &['"'; 3]) || starts_with(&line, i, &['\''; 3]))
            {
                open = Some(Open::String(line[i..i + 3].to_vec()));
                row.push(Token::String, 3);
                i += 3;
                continue;
            }
            if c == '"' || c == '\'' || c == '`' {
                let mut j = i + 1;
                while j < n {
                    if line[j] == '\\' {
                        j += 2;
                        continue;
                    }
                    if line[j] == c {
                        j += 1;
                        break;
                    }
                    j += 1;
                }
                if c == '`' && j >= n && line[n - 1] != c {
                    open = Some(Open::String(vec!['`']));
                }
                let end = j.min(n);
                row.push(Token::String, end - i);
                i = end;
                continue;
            }
            if c.is_ascii_digit() {
                let mut j = i;
                while j < n && (line[j].is_ascii_hexdigit() || "xX._n".contains(line[j])) {
                    j += 1;
                }
                row.push(Token::Number, j - i);
                i = j;
                continue;
            }
            if c.is_ascii_alphabetic() || "_$@".contains(c) {
                let mut j = i + 1;
                while j < n && (is_word(line[j]) || line[j] == '$' || (css && line[j] == '-')) {
                    j += 1;
                }
                let word: String = line[i..j].iter().collect();
                let mut token = if KEYWORDS.contains(word.as_str()) {
                    Token::Keyword
                } else if c.is_ascii_uppercase() && word.chars().any(|w| w.is_ascii_lowercase()) {
                    Token::TypeOrTag
                } else {
                    Token::Identifier
                };
                let before = |back: usize| i.checked_sub(back).map(|at| line[at]);
                if dialect == Dialect::Tsx
                    && (before(1) == Some('<')
                        || (before(1) == Some('/') && before(2) == Some('<')))
                {
                    token = Token::TypeOrTag;
                }
                if css && line.get(j) == Some(&':') {
                    token = Token::Keyword;
                }
                row.push(token, j - i);
                i = j;
                continue;
            }
            row.push(Token::Punctuation, 1);
            i += 1;
        }
        rows.push(row);
    }
    rows
}

/// Where a file's shape sits in the shared buffer.
pub(super) struct ShapeSpan {
    pub offset: usize,
    pub rows: usize,
    /// Source lines per row, above 1 once a long file is sampled.
    pub lines_per_row: f64,
}

/// Appends a file's shape: per row, a count byte, then per run its class << 5 | length - 1.
pub(super) fn encode_shape(
    text: &str,
    kind: FileKind,
    line_count: usize,
    bytes: &mut Vec<u8>,
) -> ShapeSpan {
    let mut rows = lex(text, Dialect::of(kind));
    if rows.len() > line_count && rows.last().is_some_and(|row| row.0.is_empty()) {
        rows.pop();
    }
    let mut step = 1.0;
    if rows.len() > MAX_ROWS {
        step = rows.len() as f64 / MAX_ROWS as f64;
        let mut sampled = Vec::with_capacity(MAX_ROWS);
        for row in 0..MAX_ROWS {
            let source = (row as f64 * step).floor() as usize;
            sampled.push(Row(std::mem::take(&mut rows[source].0)));
        }
        rows = sampled;
    }

    let offset = bytes.len();
    for row in &rows {
        let mut runs = Vec::new();
        for &(token, total) in &row.0 {
            let mut len = total;
            while len > 0 {
                let chunk = len.min(32);
                runs.push(((token as u8) << 5) | (chunk - 1) as u8);
                len -= chunk;
            }
        }
        let count = runs.len().min(255);
        bytes.push(count as u8);
        bytes.extend_from_slice(&runs[..count]);
    }
    ShapeSpan {
        offset,
        rows: rows.len(),
        lines_per_row: (step * 100.0).round() / 100.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(text: &str, kind: FileKind) -> Vec<Vec<(Token, usize)>> {
        lex(text, Dialect::of(kind))
            .into_iter()
            .map(|row| row.0)
            .collect()
    }

    #[test]
    fn classes_a_line_of_typescript() {
        use Token::*;
        assert_eq!(
            tokens("const Foo = \"x\"; // done", FileKind::Ts),
            vec![vec![
                (Keyword, 5),
                (Space, 1),
                (TypeOrTag, 3),
                (Space, 1),
                (Punctuation, 1),
                (Space, 1),
                (String, 3),
                (Punctuation, 1),
                (Space, 1),
                (Comment, 7),
            ]]
        );
    }

    #[test]
    fn carries_comments_and_template_strings_across_lines() {
        use Token::*;
        let rows = tokens("/* a\nb */ x\n`one\ntwo`", FileKind::Js);
        assert_eq!(rows[0], vec![(Comment, 4)]);
        assert_eq!(rows[1], vec![(Comment, 4), (Space, 1), (Identifier, 1)]);
        assert_eq!(rows[2], vec![(String, 4)]);
        assert_eq!(rows[3], vec![(String, 4)]);
    }

    #[test]
    fn splits_long_runs_and_samples_long_files() {
        let mut bytes = Vec::new();
        let span = encode_shape(&"a".repeat(40), FileKind::Ts, 1, &mut bytes);
        assert_eq!(span.rows, 1);
        // 40 identifier characters: a run of 32 and a run of 8.
        assert_eq!(bytes, vec![2, (1 << 5) | 31, (1 << 5) | 7]);

        let long = "x\n".repeat(MAX_ROWS * 2);
        let span = encode_shape(&long, FileKind::Ts, MAX_ROWS * 2, &mut bytes);
        assert_eq!(span.rows, MAX_ROWS);
        assert_eq!(span.lines_per_row, 2.0);
    }
}
