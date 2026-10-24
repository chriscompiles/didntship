const copyButton = document.getElementById("copy-link");
copyButton?.addEventListener("click", async () => {
  const status = document.getElementById("share-status");
  try {
    await navigator.clipboard.writeText(copyButton.dataset.url);
    status.textContent = "Link copied. Give that unfinished project its moment.";
  } catch {
    status.textContent = `Copy this link: ${copyButton.dataset.url}`;
  }
});
