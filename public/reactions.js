(() => {
  const buttons = Array.from(document.querySelectorAll("[data-react-id]"));
  if (!buttons.length) return;
  let saving = false;
  const known = new Map();
  function update(state) {
    known.set(String(state.id), state);
    for (const button of buttons.filter((button) => button.dataset.reactId === String(state.id))) {
      button.querySelector(".reaction-count").textContent = state.count;
      button.setAttribute("aria-pressed", String(state.reacted));
      button.disabled = state.reacted || saving;
    }
  }
  function message(id, text) {
    document.querySelectorAll(`[data-reaction-status="${id}"]`).forEach((element) => { element.textContent = text; });
  }
  async function load() {
    try {
      const ids = [...new Set(buttons.map((button) => button.dataset.reactId))].join(",");
      const response = await fetch(`/api/reactions?ids=${ids}`, { cache: "no-store" });
      if (!response.ok) throw new Error("unavailable");
      const states = await response.json();
      states.forEach(update);
    } catch {
      buttons.forEach((button) => message(button.dataset.reactId, "Reactions are temporarily unavailable. Please refresh to try again."));
    }
  }
  buttons.forEach((button) => button.addEventListener("click", async () => {
    if (saving) return;
    saving = true;
    buttons.forEach((button) => { button.disabled = true; });
    const id = button.dataset.reactId;
    message(id, "Saving…");
    try {
      const response = await fetch(`/api/confessions/${id}/reaction`, { method: "POST", cache: "no-store" });
      const state = await response.json();
      if (!response.ok) throw Object.assign(new Error(state.error || "Couldn’t save your reaction. Please try again."), { display: true });
      update(state);
      message(id, "You’re in good company.");
    } catch (error) { message(id, error.display ? error.message : "Couldn’t save your reaction. Please try again."); }
    finally {
      saving = false;
      known.forEach(update);
    }
  }));
  load();
})();
