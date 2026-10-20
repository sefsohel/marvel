// Local, fixed administrator password.
//
// SECURITY LIMITATION: this value ships to every visitor's browser. Anyone who opens the page source
// can read it. It only hides the admin UI from casual visitors. It does NOT protect Firestore.
// Replace the placeholder with your own password before deploying.
export const ADMIN_PASSWORD = "admin123";

// Only a flag is remembered for the current tab (never the password itself).
const FLAG = "ecs_admin_ui_unlocked";

export function isUnlocked() {
  try { return sessionStorage.getItem(FLAG) === "1"; } catch { return false; }
}
export function markUnlocked() { try { sessionStorage.setItem(FLAG, "1"); } catch { /* storage blocked */ } }
export function lockAdmin() { try { sessionStorage.removeItem(FLAG); } catch { /* ignore */ } }
export function passwordMatches(input) { return typeof input === "string" && input === ADMIN_PASSWORD; }

if (ADMIN_PASSWORD === "admin123") {
  console.warn("[Epic Card Studio] ADMIN_PASSWORD is still the placeholder. Edit js/password-gate.js before deploying.");
}

/** Opens the password popup. Calls onSuccess() after a correct password, onCancel() when dismissed. */
export function openPasswordDialog({ onSuccess, onCancel }) {
  const dlg = document.createElement("dialog");
  dlg.className = "gate cut-box";
  dlg.setAttribute("aria-labelledby", "gate-title");
  dlg.innerHTML = `
    <form class="gate-form" autocomplete="off" novalidate>
      <h2 id="gate-title">ADMIN ACCESS</h2>
      <p class="gate-lead">Enter the administrator password to manage templates.</p>
      <label for="gate-input">Password</label>
      <input id="gate-input" name="gate-password" type="password" autocomplete="off" spellcheck="false" required>
      <label class="gate-show"><input type="checkbox" id="gate-show"> Show password</label>
      <p class="gate-error" id="gate-error" role="alert" hidden></p>
      <div class="gate-actions">
        <button type="button" class="btn btn-ghost" data-act="cancel">CANCEL</button>
        <button type="submit" class="btn btn-primary">UNLOCK</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector("form");
  const input = dlg.querySelector("#gate-input");
  const err = dlg.querySelector("#gate-error");
  let done = false;

  const close = (cb) => { if (done) return; done = true; dlg.close(); dlg.remove(); cb && cb(); };
  dlg.querySelector("#gate-show").addEventListener("change", (e) => { input.type = e.target.checked ? "text" : "password"; });
  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => close(onCancel));
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(onCancel); });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (passwordMatches(input.value)) {
      markUnlocked();
      close(onSuccess);
    } else {
      err.textContent = "Incorrect password. Try again.";
      err.hidden = false;
      dlg.classList.remove("shake"); void dlg.offsetWidth; dlg.classList.add("shake");
      input.select();
    }
  });
  dlg.showModal();
  input.focus();
}
