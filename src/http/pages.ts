/** Minimal HTML shell for the few pages the HTTP server shows in a browser. `body` must be pre-escaped. */
export function renderPage(title: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}` +
    `button{font-size:1rem;padding:.5rem 1rem;margin:.25rem .25rem 0 0;cursor:pointer}</style>` +
    `</head><body><h1>${title}</h1>${body}</body></html>`
  );
}
