# assets/

Optional folder for images you want to reference from templates or pages.

Notes:

- Templates are stored in Firestore as plain HTML text (limit about 900 KB each). Files in this folder are **not** uploaded to Firebase.
- For an image to appear in a PDF it must be same-origin or served with CORS headers (`Access-Control-Allow-Origin`). Inline SVG and `data:` URIs are the most reliable choice.
- The landing page wallpaper is loaded from `https://i.ibb.co.com/V0HwcrGP/image.png` as specified.
