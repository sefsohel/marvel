# EPIC CARD STUDIO

A template-driven card design and PDF download site with two editions, **Color** and **Black-and-White Manga**.
Plain HTML5, CSS3 and vanilla JavaScript (ES modules). No framework, no build step, no custom backend.

- Landing page with a blurred wallpaper and a hidden Settings control
- Edition screen: **COLOR REALM** and **MONO CHAPTER**
- Four independent HTML templates stored in **Cloud Firestore**
- Admin workbench: edit, upload, live A4 preview, save, version history, restore, downloads, ZIP export
- Client-side PDF generation: one PDF per edition, exactly two **A4 portrait** pages (front, then back)

## 1. Run it locally

ES modules do not load from `file://`, so serve the folder over HTTP:

```bash
cd epic-card-studio
python3 -m http.server 8080        # or: npx serve .
```

Open <http://localhost:8080/> (served from `index.html`).

Any static host works as well (Firebase Hosting, Netlify, GitHub Pages, Cloudflare Pages).

## Deploy to the internet

The folder is a plain static site: upload it as-is, with `index.html` at the root. No build step.

- **Netlify:** drag the unzipped folder onto <https://app.netlify.com/drop> (or connect a repo; `netlify.toml` is included).
- **Cloudflare Pages / Vercel:** create a project, framework "None", no build command, output directory `/`.
- **GitHub Pages:** push the folder contents to a repo, then Settings > Pages > deploy from the branch root (`.nojekyll` is included).
- **Firebase Hosting:** `npm i -g firebase-tools && firebase login && firebase init hosting` (public directory `.`, single-page app: **No**, do not overwrite `index.html`), then `firebase deploy`. A `firebase.json` is included.
- **Any web server / shared hosting:** upload every file to the web root or a subfolder. All paths are relative, so subfolders work.

After deploying:
1. Set your password in `js/password-gate.js` **before** uploading.
2. Publish the Firestore rules (section 4).
3. Open `https://your-site/`, click the faint Settings icon, unlock and press **INITIALIZE MISSING**.

HTTPS is required for nothing special here, but all hosts above provide it by default.

## 2. Set your admin password

Open `js/password-gate.js` and replace the placeholder:

```javascript
export const ADMIN_PASSWORD = "REPLACE_WITH_MY_FIXED_PASSWORD";
```

There is no password-change form, reset flow, sign-in or account system by design.

## 3. Set up Cloud Firestore

The Firebase web config is already in `js/firebase-config.js`.

1. Open the Firebase console, project `cloud-storage-6a7e1`, then **Build > Firestore Database > Create database**.
2. Open **Firestore > Rules**, paste the rules from section 4, and **Publish**.
3. Open the site, click the faint Settings icon (top right of the landing page), enter your password.
4. Click **INITIALIZE MISSING** to save the four bundled starter templates. This only creates templates that do not exist yet and never overwrites existing ones. (You can also open a template, press **LOAD STARTER**, and save it yourself.)

Data layout:

| Collection | Document ID | Fields |
|---|---|---|
| `cardTemplates` | `color_front`, `color_back`, `manga_front`, `manga_back` | `filename`, `html`, `updatedAt` |
| `cardTemplateVersions` | `<templateId>__<timestamp>_<random>` | `templateId`, `filename`, `html`, `savedAt`, `originalUpdatedAt`, `reason` |

Every save runs a Firestore **transaction**: the existing template is copied into `cardTemplateVersions`, then the new source becomes current. If any step fails nothing is written and the UI shows the error. After saving, the app reads the document back and compares it before reporting success. A **restore** works the same way (the current version is archived first) and only touches the selected template. Because history stores the version being replaced, the very first save of a template creates no history entry.

Each document must stay under 1 MiB, so the app rejects templates above about 900 KB (large embedded images count).

## 4. Firestore rules and the security limitation (read this)

**A password stored in browser JavaScript is not security.** `ADMIN_PASSWORD` is delivered to every visitor and can be read in the page source or the network tab. It hides the admin screen from casual visitors, nothing more. Without sign-in or server-side code, Firestore cannot tell the administrator from anyone else, so the database rules decide what anonymous visitors can do. The unlocked state is only a flag in `sessionStorage` (never the password) and can be set by anyone in the developer console.

Because there is no sign-in and no backend, the app must be able to **write to Firestore anonymously**. The rules below are the least-bad choice for that setup. They validate the data shape, forbid deletes and edits of history, and restrict writes to the four known templates, **but they still let anyone who knows your project config overwrite your templates**. Version history lets you recover from that, but it does not prevent it.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function validId(id) {
      return id in ['color_front', 'color_back', 'manga_front', 'manga_back'];
    }

    match /cardTemplates/{id} {
      allow read: if true;
      allow create, update: if validId(id)
        && request.resource.data.keys().hasOnly(['filename', 'html', 'updatedAt'])
        && request.resource.data.filename == id + '.html'
        && request.resource.data.html is string
        && request.resource.data.html.size() > 0
        && request.resource.data.html.size() < 900000
        && request.resource.data.updatedAt == request.time;
      allow delete: if false;
    }

    match /cardTemplateVersions/{versionId} {
      allow read: if true;
      allow create: if request.resource.data.keys().hasOnly(
            ['templateId', 'filename', 'html', 'savedAt', 'originalUpdatedAt', 'reason'])
        && validId(request.resource.data.templateId)
        && request.resource.data.html is string
        && request.resource.data.html.size() < 900000
        && request.resource.data.savedAt == request.time;
      allow update, delete: if false;
    }
  }
}
```

**These rules allow anyone to read and to write your template data.** Do not describe the fixed password as database protection. Options for real protection:

- **Lock writes** once the templates are final: change `allow create, update` to `if false` and edit via the Firebase console. Visitors can still generate PDFs (read-only).
- **Add real authentication** (Firebase Authentication, restricted by rules to your user ID) or **server-side verification** (Cloud Functions that check a secret). Both are outside the scope of this static version.
- Add Firebase **App Check** and per-IP quotas to reduce abuse.

Never put the admin password into Firestore (this project does not).

## 5. Using the workbench (`settings.html`)

The page always shows the password popup first, even when opened directly.

- **Cards**: one per template with live thumbnail, Firebase status, last update and actions: **EDIT HTML**, **UPLOAD HTML**, **HISTORY**, **DOWNLOAD** (current Firestore copy under its original filename).
- **Editor**: monospaced textarea, filename, character count, unsaved indicator, Save and Cancel. Tabs switch between the four templates. Unsaved changes trigger a confirmation when you switch, cancel or close the tab.
- **Upload**: choose an `.html`/`.htm` file. It loads into the editor only. **Nothing is saved until you press SAVE TO FIREBASE.**
- **Live preview**: an A4 portrait sheet (210 x 297 mm) with the template centred exactly as in the PDF. It updates as you type.
- **History**: list of archived versions with timestamps. **PREVIEW** shows one without touching the editor; **RESTORE** (after confirmation) archives the current version and restores the selected one.
- **EXPORT ALL HTML (.ZIP)**: downloads the four latest Firestore versions. If any cannot be fetched, the export is cancelled with a list of failures. Stale local defaults are never used.

## 6. PDF generation

`js/pdf-generator.js` loads the latest template from Firestore (falling back to the bundled starter, with a visible warning, if a document is missing or Firebase is unreachable), renders it in a hidden script-free iframe, waits for fonts and images, captures it with **html2canvas**, centres it on an A4 canvas and assembles the PDF with **jsPDF**.

Result: `color_edition.pdf` (color front, color back) and `manga_edition.pdf` (manga front, manga back). Before download, the code checks the page count and the A4 page size and fails loudly if they are wrong.

Limitations (honest list):

- html2canvas draws a **raster** image of each page. The PDF looks like the template but its text is not selectable and it is not vector.
- html2canvas does not support everything: **`clip-path`, CSS filters, `mix-blend-mode`, `backdrop-filter`** and some exotic gradients are ignored. Use inline SVG for angled shapes (the starters do).
- Scripts inside templates are **not executed** in the preview or the PDF. Template code is trusted content; only save HTML you trust.
- External images, fonts and stylesheets must be CORS-enabled to render in the PDF. Inline SVG and `data:` URIs are safest. Web fonts that are not loaded in the template's own `<head>` fall back to system fonts. Text inside inline SVG uses system fonts.
- Cards are drawn at their natural size (1 CSS px = 1/96 in) and only shrunk, never enlarged, to fit inside a 10 mm margin.

## 7. Writing templates

Each template is a standalone HTML document. Conventions:

- Build inside one fixed-size root with `overflow:hidden` (the starters use `.card`, 640 x 960 px).
- Default card size is 640 x 960. To change it add `<meta name="card-size" content="600x840">` in `<head>`.
- Keep `html, body { margin: 0 }`.
- Keep front and back visually related but independent: the four starters share no markup.

## 8. Project structure

```
epic-card-studio/
├── index.html            landing page and site entry point (blurred wallpaper, DOWNLOAD, hidden Settings)
├── landing.html          tiny redirect to index.html (kept for compatibility)
├── netlify.toml / firebase.json / .nojekyll   optional hosting configs
├── editions.html         COLOR REALM | MONO CHAPTER
├── settings.html         password-gated admin workbench
├── css/styles.css        design system (Rajdhani, cut-corner panels, responsive)
├── js/
│   ├── firebase-config.js   Firebase web config + limits
│   ├── firebase.js          Firestore layer (transactions, history, restore)
│   ├── password-gate.js     fixed local password + dialog
│   ├── app.js               shared helpers, landing and editions behaviour
│   ├── templates.js         template catalogue, isolated renderer, A4 preview
│   ├── pdf-generator.js     HTML -> A4 PDF
│   └── admin.js             workbench logic, ZIP export
├── templates/            bundled starters (initial content / fallback)
└── assets/README.md
```

## 9. Dependencies (CDN, no install)

| Library | Use | Loaded from |
|---|---|---|
| Firebase JS SDK 10.12.2 (modular) | Cloud Firestore | gstatic.com |
| html2canvas 1.4.1 | rasterise templates | cdnjs |
| jsPDF 2.5.1 | build the PDF | cdnjs |
| JSZip 3.10.1 | ZIP export | cdnjs |
| Rajdhani (Google Fonts) | all site text | fonts.googleapis.com |

The editor textarea is monospaced on purpose; everything else uses Rajdhani.

## 10. Troubleshooting

| Message | Cause |
|---|---|
| "must be served over http" banner | Opened via `file://`. Use a local server. |
| "Firestore refused ..." (permission-denied) | Rules not published or too strict. See section 4. |
| "database was not found" | Create the Firestore database in the console. |
| "has not been saved to Firebase yet" | Use **INITIALIZE MISSING** or save each template once. |
| Image missing in PDF | External image without CORS. Inline it as SVG or `data:` URI. |
| Wallpaper missing | `i.ibb.co.com` unreachable; the page still works on a dark background. |

## 11. What was tested

With Chromium (CDN libraries and Firestore stubbed locally, since the build environment could not reach Google or cdnjs): landing page, Settings reveal and password popup (wrong and right password), admin load, initialize, edit, save with archive, history list, version preview, restore, unsaved-change guard, ZIP export, both PDF downloads (2 pages each, 210 x 297 mm, front then back, centred) and mobile layout without horizontal overflow. **Please run one real pass against your live Firestore database** after publishing the rules.
