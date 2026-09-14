// Docs-site plugin: line icons, SEO head tags, static files. Reads
// package.json, so nothing here is package-specific except the file list.
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSX, ReflectionKind, RendererEvent } from 'typedoc';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const desc = pkg.description.split(/(?<=\.)\s/)[0]; // first sentence: snippet length
const STATIC = ['llms.txt', 'site/robots.txt', ['.github/social-preview.png', 'og.png']];

// Lucide paths (ISC). Stroke colour comes from typedoc's per-kind variables.
const P = {
  layers: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83ZM22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65',
  box: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16ZM3.3 7l8.7 5 8.7-5M12 22V12',
  braces: 'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1',
  fn: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3M9 11.2h5.7',
  variable: 'M8 21s-4-3-4-9 4-9 4-9M16 3s4 3 4 9-4 9-4 9M15 9l-6 6M9 9l6 6',
  type: 'M4 7V4h16v3M9 20h6M12 4v16',
  list: 'M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  plus: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM8 12h8M12 8v8',
  arrows: 'M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  folder: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  file: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8',
  chevron: 'm6 9 6 6 6-6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  menu: 'M4 12h16M4 6h16M4 18h16',
};

const h = JSX.createElement;
const icon = (d, color, label) =>
  h('svg', { class: 'tsd-kind-icon', viewBox: '0 0 24 24', 'aria-label': label },
    h('path', { d, fill: 'none', stroke: color, 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
const ui = (d, size = 20) =>
  h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d, stroke: 'var(--color-icon-text)', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));

const K = ReflectionKind;
const kind = (d, v, label) => () => icon(P[d], `var(--color-ts-${v})`, label);
const ICONS = {
  [K.Project]: kind('layers', 'module', 'Project'),
  [K.Module]: kind('layers', 'module', 'Module'),
  [K.Namespace]: kind('folder', 'namespace', 'Namespace'),
  [K.Class]: kind('box', 'class', 'Class'),
  [K.Interface]: kind('braces', 'interface', 'Interface'),
  [K.Function]: kind('fn', 'function', 'Function'),
  [K.CallSignature]: kind('fn', 'function', 'Call signature'),
  [K.Method]: kind('fn', 'method', 'Method'),
  [K.Constructor]: kind('plus', 'constructor', 'Constructor'),
  [K.ConstructorSignature]: kind('plus', 'constructor', 'Constructor signature'),
  [K.Variable]: kind('variable', 'variable', 'Variable'),
  [K.TypeAlias]: kind('type', 'type-alias', 'Type alias'),
  [K.TypeLiteral]: kind('type', 'type-alias', 'Type literal'),
  [K.TypeParameter]: kind('type', 'type-parameter', 'Type parameter'),
  [K.Enum]: kind('list', 'enum', 'Enumeration'),
  [K.EnumMember]: kind('hash', 'enum-member', 'Enumeration member'),
  [K.Property]: kind('hash', 'property', 'Property'),
  [K.Parameter]: kind('hash', 'parameter', 'Parameter'),
  [K.IndexSignature]: kind('hash', 'index-signature', 'Index signature'),
  [K.Accessor]: kind('arrows', 'accessor', 'Accessor'),
  [K.GetSignature]: kind('arrows', 'get-signature', 'Get signature'),
  [K.SetSignature]: kind('arrows', 'set-signature', 'Set signature'),
  [K.Reference]: kind('link', 'reference', 'Reference'),
  [K.Document]: kind('file', 'module', 'Document'),
  folder: kind('folder', 'namespace', 'Folder'),
  chevronDown: () => ui(P.chevron),
  chevronSmall: () => ui(P.chevron, 16),
  search: () => ui(P.search, 16),
  menu: () => ui(P.menu, 16),
};

export function load(app) {
  const base = app.options.getValue('hostedBaseUrl').replace(/\/?$/, '/');

  app.renderer.on(RendererEvent.BEGIN, () => Object.assign(app.renderer.theme.icons, ICONS));

  app.renderer.hooks.on('head.end', (ctx) => {
    const page = ctx.page;
    const isIndex = page.url === 'index.html';
    const title = isIndex ? `${pkg.name} — ${pkg.description.split('.')[0]}` : `${page.model.name} · ${pkg.name}`;
    const url = base + page.url;
    const tags = [
      h('link', { rel: 'canonical', href: url }),
      h('meta', { name: 'keywords', content: (pkg.keywords ?? []).join(', ') }),
      h('meta', { property: 'og:type', content: 'website' }),
      h('meta', { property: 'og:site_name', content: pkg.name }),
      h('meta', { property: 'og:title', content: title }),
      h('meta', { property: 'og:description', content: desc }),
      h('meta', { property: 'og:url', content: url }),
      h('meta', { property: 'og:image', content: base + 'og.png' }),
      h('meta', { name: 'twitter:card', content: 'summary_large_image' }),
      h('meta', { name: 'twitter:title', content: title }),
      h('meta', { name: 'twitter:description', content: desc }),
      h('meta', { name: 'twitter:image', content: base + 'og.png' }),
    ];
    if (isIndex) {
      tags.push(h('script', { type: 'application/ld+json' }, h(JSX.Raw, { html: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareSourceCode',
        name: pkg.name,
        description: pkg.description,
        url: base,
        codeRepository: pkg.repository?.url?.replace(/^git\+|\.git$/g, ''),
        programmingLanguage: 'TypeScript',
        runtimePlatform: 'Node.js',
        license: `https://opensource.org/licenses/${pkg.license}`,
        version: pkg.version,
        keywords: (pkg.keywords ?? []).join(', '),
      }) })));
    }
    return h(JSX.Fragment, null, ...tags);
  });

  app.renderer.on(RendererEvent.END, (ev) => {
    const out = ev.outputDirectory;
    for (const f of STATIC) {
      const [src, dst] = Array.isArray(f) ? f : [f, f.split('/').pop()];
      copyFileSync(src, join(out, dst));
    }
    // typedoc's own description is "Documentation for <name>"; use the real one
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : []);
    for (const f of walk(out)) {
      const html = readFileSync(f, 'utf8');
      const fixed = html.replace(/<meta name="description" content="[^"]*"\/>/, `<meta name="description" content="${desc.replace(/"/g, '&quot;')}"/>`);
      if (fixed !== html) writeFileSync(f, fixed);
    }
  });
}
