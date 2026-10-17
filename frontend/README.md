# Frontend source

Based on MIT-licensed `MarSeventh/Sanyue-ImgHub` commit `ab5fe6990a944acb03ad70aecd3b774002942d54` (v2.7.4), matching this repository's frontend version. Local changes add a read-only fixed ID and permanent link to file details, initialize legacy identities on demand, and prefer fixed IDs when copying links.

File names and path basenames are now synchronized through one edit form. The independent path rename UI and upload naming-style choices are removed. The dashboard automatically resumes the authenticated legacy-name normalization job and reports skipped files.

Rebuild the served files from this directory:

```sh
npm ci --ignore-scripts
npm run build -- --dest ../frontend-dist
```

Cloudflare Pages continues to serve the committed `frontend-dist` artifacts using the existing `npm install` build configuration. Rebuild this frontend after changing its sources. The root Pages build command does not need to change.
