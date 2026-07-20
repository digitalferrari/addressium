/*
 * addressium embeddable signup widget (#6).
 * Usage: <div data-addressium data-org="ORG" data-list="LIST"></div>
 *        <script async src="https://<public-site>/embed.js"></script>
 * Renders a self-contained double-opt-in signup form that posts to the API.
 * Configure the API base with data-api on the div (defaults to same origin).
 */
(function () {
  var mounts = document.querySelectorAll("[data-addressium]:not([data-mounted])");
  for (var i = 0; i < mounts.length; i++) mount(mounts[i]);

  function mount(el) {
    el.setAttribute("data-mounted", "1");
    var org = el.getAttribute("data-org");
    var list = el.getAttribute("data-list");
    var api = el.getAttribute("data-api") || "";
    if (!org || !list) { el.textContent = "addressium: missing data-org/data-list"; return; }

    var wrap = document.createElement("div");
    wrap.style.cssText = "font-family:system-ui,sans-serif;border:1px solid #e6e9ef;border-radius:12px;padding:16px;max-width:420px;background:#fff";
    var input = document.createElement("input");
    input.type = "email";
    input.placeholder = "you@example.com";
    input.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #e6e9ef;border-radius:8px;padding:10px 12px;font-size:14px";
    var btn = document.createElement("button");
    btn.textContent = "Subscribe";
    btn.style.cssText = "margin-top:10px;background:#4f8cff;color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer";
    var msg = document.createElement("div");
    msg.style.cssText = "margin-top:8px;font-size:13px;color:#5a6473";

    btn.onclick = function () {
      msg.textContent = "…";
      fetch(api + "/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId: org, email: input.value, listId: list }),
      })
        .then(function (r) { if (!r.ok) throw new Error("signup failed"); return r.json(); })
        .then(function (j) { msg.textContent = j.status === "pending" ? "Check your inbox to confirm." : "Subscribed!"; input.value = ""; })
        .catch(function () { msg.textContent = "Something went wrong. Try again."; });
    };

    wrap.appendChild(input);
    wrap.appendChild(btn);
    wrap.appendChild(msg);
    el.appendChild(wrap);
  }
})();
