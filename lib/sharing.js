function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function socialMeta({ title, description, url, image, alt }) {
  return `<link rel="canonical" href="${escapeHtml(url)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="didntship.lol">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(url)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${escapeHtml(alt)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">
  <meta name="twitter:image:alt" content="${escapeHtml(alt)}">`;
}

function shell({ title, head = "", body, script = "" }) {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23c93622'/><path d='M24 22h26c19 0 30 10 30 28S69 78 50 78H24zm25 42c9 0 14-5 14-14s-5-14-14-14h-8v28z' fill='%23fff'/></svg>">
  <link rel="stylesheet" href="/styles.css">
  ${head}
</head><body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="site-header"><a class="brand" href="/">didntship<span>.lol</span></a><p class="site-note">At least make it famous.</p></header>
  <main id="main-content" class="confession-main">${body}
    <footer><span>No accounts. No deletes.</span><strong>This is the receipt.</strong></footer>
  </main>${script ? `<script src="${script}" defer></script>` : ""}
</body></html>`;
}

function renderConfession(row, publicUrl) {
  const url = `${publicUrl}/confessions/${row.id}`;
  const image = `${url}/card.png?v=1`;
  const title = "Didn’t ship. At least it’s famous now. | didntship.lol";
  const description = row.body;
  const shareText = `“${row.body}”\n\nDidn’t ship. At least it’s famous now.\n\nConfess yours for $1.`;
  const intent = `https://twitter.com/intent/tweet?${new URLSearchParams({ text: shareText, url })}`;
  const author = row.handle ? `@${escapeHtml(row.handle)}` : "Anonymous builder";
  return shell({
    title,
    head: `<meta name="description" content="${escapeHtml(description)}">\n${socialMeta({ title, description, url, image, alt: `${row.body} — ${row.handle ? `@${row.handle}` : "Anonymous builder"}. didntship.lol` })}`,
    body: `<section class="confession-heading">
      <p class="eyebrow">${row.is_demo ? "Example confession" : `Confession #${String(row.id).padStart(4, "0")}`}</p>
      <h1 class="confession-title">Didn’t ship.<br><span>Made it famous.</span></h1>
      <blockquote class="confession-quote"><p>${escapeHtml(row.body)}</p><cite>${author}</cite></blockquote>
      ${row.link ? `<a class="link confession-project" href="${escapeHtml(row.link)}" rel="nofollow noopener noreferrer" target="_blank">Visit the project ↗</a>` : ""}
    </section>
    <section class="share-section" aria-labelledby="share-title">
      <div class="share-intro"><p class="eyebrow">This is your moment</p><h2 id="share-title">Give it an audience.</h2>
        <p>The project didn’t make it. The confession can.</p></div>
      <img class="share-preview" src="/confessions/${row.id}/card.png?v=1" width="1200" height="630" alt="${escapeHtml(row.body)} — ${author}" fetchpriority="high">
      <div class="share-actions">
        <a class="action-link action-primary" href="${escapeHtml(intent)}" target="_blank" rel="noopener noreferrer">Share on X <span aria-hidden="true">↗</span></a>
        <a class="action-link" href="/confessions/${row.id}/card.png?download=1" download="didntship-confession-${row.id}.png">Download card <span aria-hidden="true">↓</span></a>
        <button class="action-link" type="button" id="copy-link" data-url="${escapeHtml(url)}">Copy link</button>
      </div>
      <p class="share-status" id="share-status" role="status" aria-live="polite"></p>
      <p class="share-help">Share on X opens a draft with this confession’s link. To post the image itself, download the card and attach it to your post.</p>
    </section>
    <section class="confess-cta"><h2>Your side project made $0.<br>At least make it famous.</h2>
      <p>One line. Your excuse. A permanent place on the wall.</p><a class="action-link action-primary" href="/#submit-title">Confess yours · $1 <span aria-hidden="true">↗</span></a>
      <a class="back-link" href="/#wall-title">Read the wall</a></section>`,
    script: "/sharing.js",
  });
}

function renderConfirmation(validSession) {
  return shell({
    title: "Confirming your confession | didntship.lol",
    head: '<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">',
    body: `<section class="confirmation"><p class="eyebrow">${validSession ? "One moment" : "Confirmation link needed"}</p>
      <h1 class="confession-title">${validSession ? "Your confession<br>is on its way." : "Back to the wall."}</h1>
      <p id="confirmation-status" role="status" aria-live="polite">${validSession ? "We’re waiting for payment confirmation. This page will take you straight to your shareable card when it’s ready." : "Open the confirmation link from checkout, or find your confession on the wall."}</p>
      ${validSession ? '<p class="share-help">Some payments take longer to clear. Please keep this confirmation link and avoid paying again.</p><button class="action-link" id="retry-confirmation" type="button" hidden>Check again</button><noscript><p>Refresh this page to check for confirmation.</p></noscript>' : ""}
      <a class="back-link" href="/#wall-title">Read the wall</a></section>`,
    script: validSession ? "/checkout-status.js" : "",
  });
}

module.exports = { socialMeta, renderConfession, renderConfirmation };
