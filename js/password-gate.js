
import { signInAdmin } from "./firebase.js";

const FLAG = "ecs_admin_ui_unlocked";

export function isUnlocked() {
  try {
    return sessionStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

export function markUnlocked() {
  try {
    sessionStorage.setItem(FLAG, "1");
  } catch {
    // Storage may be disabled by the browser.
  }
}

export function lockAdmin() {
  try {
    sessionStorage.removeItem(FLAG);
  } catch {
    // Ignore storage errors.
  }
}

export function openPasswordDialog({ onSuccess, onCancel }) {
  const dlg = document.createElement("dialog");
  dlg.className = "gate cut-box";
  dlg.setAttribute("aria-labelledby", "gate-title");

  dlg.innerHTML = `
    <form class="gate-form" autocomplete="on">
      <h2 id="gate-title">ADMIN SIGN IN</h2>

      <p class="gate-lead">
        Sign in using your authorized Firebase admin account.
      </p>

      <label for="gate-email">Admin email</label>
      <input
        id="gate-email"
        name="email"
        type="email"
        autocomplete="username"
        required
      >

      <label for="gate-password">Password</label>
      <input
        id="gate-password"
        name="password"
        type="password"
        autocomplete="current-password"
        required
      >

      <label class="gate-show">
        <input type="checkbox" id="gate-show">
        Show password
      </label>

      <p class="gate-error" id="gate-error" role="alert" hidden></p>

      <div class="gate-actions">
        <button type="button" class="btn btn-ghost" data-act="cancel">
          CANCEL
        </button>

        <button type="submit" class="btn btn-primary" id="gate-submit">
          SIGN IN
        </button>
      </div>
    </form>
  `;

  document.body.appendChild(dlg);

  const form = dlg.querySelector("form");
  const email = dlg.querySelector("#gate-email");
  const password = dlg.querySelector("#gate-password");
  const error = dlg.querySelector("#gate-error");
  const submit = dlg.querySelector("#gate-submit");

  let closed = false;

  function close(callback) {
    if (closed) return;

    closed = true;

    if (dlg.open) dlg.close();

    dlg.remove();

    if (callback) callback();
  }

  dlg.querySelector("#gate-show").addEventListener("change", (event) => {
    password.type = event.target.checked ? "text" : "password";
  });

  dlg.querySelector('[data-act="cancel"]').addEventListener("click", () => {
    close(onCancel);
  });

  dlg.addEventListener("cancel", (event) => {
    event.preventDefault();
    close(onCancel);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    error.hidden = true;
    submit.disabled = true;
    submit.textContent = "SIGNING IN…";

    try {
      await signInAdmin(email.value, password.value);

      markUnlocked();
      close(onSuccess);
    } catch (err) {
      error.textContent = err.message || "Sign-in failed.";
      error.hidden = false;
      password.select();
    } finally {
      if (!closed) {
        submit.disabled = false;
        submit.textContent = "SIGN IN";
      }
    }
  });

  dlg.showModal();
  email.focus();
}
