const session = new URLSearchParams(location.search).get("session_id");
const status = document.getElementById("confirmation-status");
const retry = document.getElementById("retry-confirmation");
let attempts = 0;
let running = false;

async function checkConfirmation() {
  if (running || !session) return;
  running = true;
  retry.hidden = true;
  try {
    const response = await fetch(`/checkout/status?${new URLSearchParams({ session_id: session })}`, { cache: "no-store", referrerPolicy: "no-referrer" });
    if (response.status === 200) {
      const result = await response.json();
      if (/^\/confessions\/[1-9][0-9]*$/.test(result.url)) {
        location.replace(result.url);
        return;
      }
    }
    if (response.status === 400 || response.status === 404) {
      status.textContent = "We couldn’t find this confirmation. Please check your link or look for your confession on the wall.";
      running = false;
      retry.hidden = false;
      return;
    }
  } catch {
    status.textContent = "The connection dropped. We’ll check for your confession again shortly.";
  }
  running = false;
  if (++attempts < 30) setTimeout(checkConfirmation, 2000);
  else {
    status.textContent = "Payment confirmation is taking a little longer. Keep this link and check again shortly. Your confession appears once payment clears.";
    retry.hidden = false;
  }
}

retry?.addEventListener("click", () => { attempts = 0; checkConfirmation(); });
checkConfirmation();
