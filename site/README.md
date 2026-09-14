# Docs site template

GitHub Pages site = typedoc + this folder. Copy to any TypeScript package:

```
typedoc.json                 entry points, project documents, links
site/index.md                landing: one-liner, install, one snippet, links out
site/theme.css               brand tokens at the top; the rest is shared
site/logo.svg, favicon.svg   mark + wordmark
site/typedoc-plugin.mjs      line icons, SEO head (OG, Twitter, JSON-LD, canonical), copies static files
site/robots.txt              points at the generated sitemap
.github/workflows/docs.yml   build on push to main, deploy to Pages
```

Per package, edit: `entryPoints`, `hostedBaseUrl`, `navigationLinks`,
`customFooterHtml` in `typedoc.json`; the two `--brand-*` tokens in
`theme.css`; the text in `index.md` and `logo.svg`; the `STATIC` list in the
plugin (needs an `og.png` source, 1280x640). Everything SEO reads
`package.json`: keep `description` (first sentence = search snippet),
`keywords`, `repository`, `license` accurate. Add
`/** @module <pkg>/<subpath> */` as line 1 of each entry file so the sidebar
matches the import path. Enable Pages → Source: GitHub Actions once.

Landing page rule: basics only. Everything else is a document
(`projectDocuments`) or the API reference.
