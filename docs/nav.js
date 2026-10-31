/* Shared sidebar + active link for the multi-page course. */
(function () {
  const pages = [
    { group: "Start here", items: [
      { href: "index.html", id: "home", label: "Course home" },
      { href: "principles.html", id: "principles", label: "Core principles" },
      { href: "architecture.html", id: "architecture", label: "Architecture map" },
      { href: "syllabus.html", id: "syllabus", label: "Full syllabus" },
    ]},
    { group: "Concepts", items: [
      { href: "concept-evals-observability.html", id: "evals", label: "Evals & observability" },
      { href: "concept-safety.html", id: "safety", label: "Safety & compliance" },
      { href: "concept-policy-vs-auth.html", id: "policy-auth", label: "Policy vs operator auth" },
      { href: "concept-cognition-model-adapter.html", id: "cognition", label: "Cognition (model adapter)" },
      { href: "concept-agent-loop.html", id: "agent-loop", label: "Agent loop (detailed)" },
      { href: "concept-durable-runs.html", id: "durable-runs", label: "Durable runs (detailed)" },
      { href: "concept-orchestrator.html", id: "orchestrator", label: "Orchestrator (detailed)" },
      { href: "concept-policy-gate.html", id: "policy-gate", label: "Policy gate (detailed)" },
    ]},
    { group: "Phase 0", items: [
      { href: "00-mental-model.html", id: "00", label: "Mental model" },
    ]},
    { group: "Week 1 — Brain & loop", items: [
      { href: "01-model-adapter.html", id: "01", label: "Model adapter" },
      { href: "02-structured-skill.html", id: "02", label: "Structured skill" },
      { href: "03-agent-loop.html", id: "03", label: "Agent loop" },
      { href: "04-durable-runs.html", id: "04", label: "Durable runs" },
    ]},
    { group: "Week 2 — Control plane", items: [
      { href: "05-orchestrator.html", id: "05", label: "Orchestrator" },
      { href: "06-policy-gate.html", id: "06", label: "Policy gate" },
      { href: "07-hitl.html", id: "07", label: "HITL approvals" },
      { href: "08-rest-api.html", id: "08", label: "REST interface" },
    ]},
    { group: "Week 3 — Clients", items: [
      { href: "09-react-ui.html", id: "09", label: "React truth UI" },
      { href: "10-live-monitoring.html", id: "10", label: "Live monitoring" },
      { href: "11-mcp-harness.html", id: "11", label: "MCP harness" },
    ]},
    { group: "Week 4 — Domain", items: [
      { href: "12-memory.html", id: "12", label: "Memory layers" },
      { href: "13-skills-media.html", id: "13", label: "Skills & media" },
      { href: "14-instagram-oauth.html", id: "14", label: "Instagram OAuth" },
      { href: "15-gated-publish.html", id: "15", label: "Gated publish" },
    ]},
    { group: "Week 5 — Quality", items: [
      { href: "16-evals.html", id: "16", label: "Evals suite" },
      { href: "17-hardening.html", id: "17", label: "Hardening" },
    ]},
  ];

  const order = pages.flatMap((g) => g.items);

  function render() {
    const mount = document.querySelector("[data-nav]");
    if (!mount) return;
    const current = mount.getAttribute("data-current") || "";

    let html = `
      <a class="brand" href="index.html">Agentic Systems</a>
      <p class="brand-sub">Learn by building a safe Instagram content agent</p>
    `;

    for (const group of pages) {
      html += `<div class="nav-label">${group.group}</div><ul class="nav-list">`;
      for (const item of group.items) {
        const currentAttr = item.id === current ? ' aria-current="page"' : "";
        const num = /^\d{2}$/.test(item.id) ? `<span class="num">${item.id}</span>` : "";
        html += `<li><a href="${item.href}"${currentAttr}>${num}${item.label}</a></li>`;
      }
      html += `</ul>`;
    }

    mount.innerHTML = html;

    const pager = document.querySelector("[data-pager]");
    if (!pager) return;
    const idx = order.findIndex((p) => p.id === current);
    if (idx < 0) return;

    const prev = order[idx - 1];
    const next = order[idx + 1];
    pager.innerHTML = `
      ${prev ? `<a href="${prev.href}"><span class="dir">Previous</span>${prev.label}</a>` : "<span></span>"}
      ${next ? `<a class="next" href="${next.href}"><span class="dir">Next</span>${next.label}</a>` : ""}
    `;
  }

  render();
})();
