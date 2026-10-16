type FileKind =
  | "code"
  | "test"
  | "doc"
  | "config"
  | "style"
  | "image"
  | "database"
  | "shell"
  | "lock"
  | "file";

/** Keyed by lowercased extension, or by the whole name for files without one. */
const KIND_BY_EXTENSION: Record<string, FileKind> = {};

function assign(kind: FileKind, extensions: string) {
  for (const extension of extensions.split(" ")) KIND_BY_EXTENSION[extension] = kind;
}

assign(
  "code",
  "ts tsx mts cts js jsx mjs cjs rs py go rb java kt swift c h cc cpp hpp cs php html vue svelte lua zig dart scala ex exs",
);
assign("doc", "md mdx txt rst adoc");
assign(
  "config",
  "json jsonc json5 yaml yml toml ini xml plist env conf cfg gitignore gitattributes editorconfig npmrc dockerfile",
);
assign("style", "css scss sass less");
assign("image", "png jpg jpeg gif svg webp avif ico icns bmp tiff heic");
assign("database", "sql sqlite db");
assign("shell", "sh bash zsh fish ps1 bat makefile");
assign("lock", "lock lockb");

/** Lockfiles whose extension would otherwise file them under config. */
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "go.sum"]);

function fileKind(name: string): FileKind {
  if (LOCKFILES.has(name)) return "lock";
  if (/\.(spec|test)\.[^.]+$/.test(name)) return "test";
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return KIND_BY_EXTENSION[extension] ?? "file";
}

const page = "M3.75 1.75h5.5l3 3v9.5h-8.5z";

/*
 * On the design system's 16×16 icon grid, drawn with its `tk-icon` outline so
 * they take the theme's stroke weight, caps and joins. `inner` strokes end on
 * another outline and are butt-capped; `fill` paths are solids.
 */
const GLYPHS: Record<FileKind, { stroke: string; inner?: string; fill?: string }> = {
  file: { stroke: `${page}M9.25 1.75v3h3` },
  doc: { stroke: `${page}M9.25 1.75v3h3M6 8.25h4M6 11h4` },
  code: { stroke: "M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" },
  test: {
    stroke: "M5 2h6M6.25 2v4.5l-3.5 6.75h10.5L9.75 6.5V2",
    fill: "M4.44 10h7.12l1.69 3.25H2.75z",
  },
  config: {
    stroke:
      "M6 2.75c-1.1 0-1.75.55-1.75 1.75v1.75c0 1.1-.5 1.75-1.5 1.75 1 0 1.5.65 1.5 1.75v1.75c0 1.2.65 1.75 1.75 1.75" +
      "M10 2.75c1.1 0 1.75.55 1.75 1.75v1.75c0 1.1.5 1.75 1.5 1.75-1 0-1.5.65-1.5 1.75v1.75c0 1.2-.65 1.75-1.75 1.75",
  },
  style: { stroke: "M3 6h10M3 10h10M6.5 3l-1 10M10.5 3l-1 10" },
  image: {
    stroke: "M2.25 3.25h11.5v9.5H2.25z",
    inner: "M2.25 11.5 6 7.75l3.25 3.25 1.5-1.5 3 3",
    fill: "M10.5 4.75a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z",
  },
  database: {
    stroke:
      "M3 4.25c0-.97 2.24-1.75 5-1.75s5 .78 5 1.75-2.24 1.75-5 1.75-5-.78-5-1.75zM3 4.25v7.5c0 .97 2.24 1.75 5 1.75s5-.78 5-1.75v-7.5",
    inner: "M3 8c0 .97 2.24 1.75 5 1.75S13 8.97 13 8",
  },
  shell: { stroke: "M3 4.5 6.5 8 3 11.5M8.5 11.5H13" },
  lock: {
    stroke: "M3.25 7.25h9.5v6.5h-9.5z",
    inner: "M5.25 7.25v-2a2.75 2.75 0 0 1 5.5 0v2",
    fill: "M8 9.25a1 1 0 1 1 0 2 1 1 0 0 1 0-2z",
  },
};

/** A small glyph for what kind of file this is, read from its name. */
export function FileIcon({ name, className }: { name: string; className?: string }) {
  const glyph = GLYPHS[fileKind(name)];
  return (
    <svg viewBox="0 0 16 16" className={`tk-icon ${className ?? ""}`} aria-hidden="true">
      {glyph.fill ? <path d={glyph.fill} className="tk-icon-fill" /> : null}
      <path d={glyph.stroke} />
      {glyph.inner ? <path d={glyph.inner} className="tk-icon-inner" /> : null}
    </svg>
  );
}
