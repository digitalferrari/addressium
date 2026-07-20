/*
 * addressium embeddable signup widget (#6, multi-select + bot mitigation #62).
 *
 * Usage — put on ANY page of your site:
 *   <div data-addressium data-org="ORG"
 *        data-api="https://<api-base>"           (optional; defaults to same origin)
 *        data-recaptcha-sitekey="6Lc..."></div>  (optional; enables reCAPTCHA v3)
 *   <script async src="https://<public-site>/embed.js"></script>
 *
 * Renders a self-contained form: an email field, a multi-select checkbox list of
 * the org's newsletters, a hidden honeypot, and a submit button. Posts to
 * /signup/batch so ONE double opt-in email covers every selected list. No account
 * or login required. If data-list is set, it renders a single-list form instead.
 */
(function () {
  var mounts = document.querySelectorAll("[data-addressium]:not([data-mounted])");
  for (var i = 0; i < mounts.length; i++) mount(mounts[i]);

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function mount(root) {
    root.setAttribute("data-mounted", "1");
    var org = root.getAttribute("data-org");
    var api = root.getAttribute("data-api") || "";
    var siteKey = root.getAttribute("data-recaptcha-sitekey") || "";
    var singleList = root.getAttribute("data-list") || "";
    if (!org) { root.textContent = "addressium: missing data-org"; return; }

    var wrap = el("div", "font-family:system-ui,sans-serif;border:1px solid #e6e9ef;border-radius:12px;padding:16px;max-width:440px;background:#fff;color:#1a2233");
    var title = el("div", "font-weight:700;font-size:15px;margin-bottom:10px", "Subscribe to our newsletters");
    var listBox = el("div", "display:flex;flex-direction:column;gap:8px;margin-bottom:12px");
    var email = el("input", "width:100%;box-sizing:border-box;border:1px solid #e6e9ef;border-radius:8px;padding:10px 12px;font-size:14px");
    email.type = "email"; email.placeholder = "you@example.com";
    // Honeypot: visually hidden, off-screen, not announced. Bots fill it; humans don't.
    var hp = el("input", "position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden");
    hp.setAttribute("tabindex", "-1"); hp.setAttribute("autocomplete", "off"); hp.setAttribute("aria-hidden", "true");
    hp.name = "website";
    var btn = el("button", "margin-top:10px;background:#2f56d4;color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer;font-size:14px", "Subscribe");
    var msg = el("div", "margin-top:8px;font-size:13px;color:#5a6473");

    var checks = {}; // listId -> checkbox

    if (siteKey && !window.__addressiumRecaptcha) {
      window.__addressiumRecaptcha = true;
      var s = document.createElement("script");
      s.src = "https://www.google.com/recaptcha/api.js?render=" + encodeURIComponent(siteKey);
      s.async = true; document.head.appendChild(s);
    }

    function addRow(id, name) {
      var row = el("label", "display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer");
      var cb = document.createElement("input"); cb.type = "checkbox"; cb.value = id;
      checks[id] = cb;
      row.appendChild(cb); row.appendChild(el("span", null, name || id));
      listBox.appendChild(row);
    }

    function selected() {
      var out = [];
      for (var id in checks) if (checks[id].checked) out.push(id);
      return out;
    }

    function withToken(cb) {
      if (siteKey && window.grecaptcha && window.grecaptcha.execute) {
        window.grecaptcha.ready(function () {
          window.grecaptcha.execute(siteKey, { action: "signup" }).then(cb).catch(function () { cb(""); });
        });
      } else { cb(""); }
    }

    function submit() {
      var ids = singleList ? [singleList] : selected();
      if (!email.value || ids.length === 0) { msg.textContent = "Pick at least one newsletter and enter your email."; return; }
      msg.textContent = "…";
      withToken(function (token) {
        fetch(api + "/signup/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orgId: org, email: email.value, listIds: ids, website: hp.value, recaptchaToken: token }),
        })
          .then(function (r) { if (!r.ok) throw new Error("signup failed"); return r.json(); })
          .then(function () { msg.textContent = "Almost there — check your inbox to confirm."; email.value = ""; })
          .catch(function () { msg.textContent = "Something went wrong. Please try again."; });
      });
    }
    btn.onclick = submit;

    wrap.appendChild(title);
    if (!singleList) wrap.appendChild(listBox);
    wrap.appendChild(email);
    wrap.appendChild(hp);
    wrap.appendChild(btn);
    wrap.appendChild(msg);
    root.appendChild(wrap);

    // Load the org's newsletters for the multi-select (skipped for single-list mode).
    if (!singleList) {
      fetch(api + "/orgs/" + encodeURIComponent(org) + "/lists")
        .then(function (r) { return r.json(); })
        .then(function (rows) {
          return Promise.all((rows || []).map(function (row) {
            return fetch(api + "/orgs/" + encodeURIComponent(org) + "/lists/" + encodeURIComponent(row.listId) + "/public")
              .then(function (r) { return r.ok ? r.json() : { listId: row.listId, name: row.listId }; })
              .catch(function () { return { listId: row.listId, name: row.listId }; });
          }));
        })
        .then(function (lists) {
          if (!lists.length) { listBox.appendChild(el("div", "font-size:13px;color:#5a6473", "No newsletters available.")); return; }
          lists.forEach(function (l) { addRow(l.listId, l.name); });
        })
        .catch(function () { listBox.appendChild(el("div", "font-size:13px;color:#c3372f", "Could not load newsletters.")); });
    }
  }
})();
