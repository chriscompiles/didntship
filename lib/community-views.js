const { weekLabel, MIN_ENTRIES, MIN_VOTERS } = require("./community");
const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function awardBadge(row) {
  return row.award_week ? `<a class="award-badge" href="/#weekly-award">Excuse of the week <span>Week of ${esc(weekLabel(row.award_week))}</span></a>` : "";
}

function reactionControl(row) {
  if (row.is_demo) return '<p class="reaction-note">Example confession · outside the weekly competition.</p>';
  return `<div class="reaction"><button type="button" class="reaction-button" data-react-id="${Number(row.id)}" aria-pressed="false" disabled>Been there <span class="reaction-count">${Number(row.reaction_count || 0)}</span></button>
    <span class="reaction-status" data-reaction-status="${Number(row.id)}" role="status" aria-live="polite"></span></div>`;
}

function weeklySection(winner) {
  return `<section class="weekly-section" id="weekly-award" aria-labelledby="weekly-title">
    <div><p class="eyebrow">Shared regret. A little recognition.</p><h2 id="weekly-title">Excuse of the week.</h2>
      ${winner ? `<p class="weekly-date">Latest winner · week of ${esc(weekLabel(winner.award_week))}</p>
        <blockquote>${esc(winner.body)}</blockquote><p>${winner.handle ? "@" + esc(winner.handle) : "Anonymous builder"} · ${Number(winner.award_reactions)} Been there reactions that week</p>
        <a class="link" href="/confessions/${winner.id}">See the winning confession and card ↗</a>` : '<p class="weekly-empty">Your excuse could have its moment.</p><p>React for free. New paid confessions compete in the week they’re posted. The winner gets a badge and a card worth sharing again.</p>'}
    </div><details class="award-rules"><summary>How the weekly award works</summary>
      <p>Weeks run Monday to Sunday in UK time. Reacting is free; confessing costs $1. Each browser can react once to each confession.</p>
      <p>Paid confessions qualify in the week they are posted. Only reactions received during that week count towards the award. Demo and hidden posts are excluded.</p>
      <p>An award needs at least ${MIN_ENTRIES} eligible confessions and ${MIN_VOTERS} distinct reacting browsers. Most reactions wins; a tie goes to the earliest published confession, then the lowest confession number.</p>
      <p>The result is saved on the first visit after the week ends. Weeks without enough participation have no winner. Existing awards stay fixed. Paid spotlight pins keep their full hour.</p>
      <p>Reactions use an anonymous browser cookie to prevent repeats. Clearing cookies or using another browser can bypass that limit; rate limits discourage abuse.</p>
    </details></section>`;
}

module.exports = { awardBadge, reactionControl, weeklySection };
