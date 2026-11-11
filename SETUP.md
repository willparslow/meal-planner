# Meal Planner: setup guide

About 20 minutes, all free. You only do this once.

The app comes in two parts:
- **The app itself**: these files, hosted on GitHub Pages.
- **Your shared data**: stored in Firebase (Google). It syncs between both phones and keeps a copy on each phone, so it works with no signal.

Until step 3 is done, the app runs in **demo mode**: everything works, but it only saves on one phone.

---

## 1. Create the Firebase project (about 8 min)

1. Go to <https://console.firebase.google.com> and sign in with your Google account.
2. **Create a project.** Call it something like `meal-planner`. You can switch off Google Analytics.
3. **Turn on sign-in:** go to *Build → Authentication → Get started → Sign-in method*, choose **Email/Password**, switch it on and save. Then *Add new provider → Google*, switch it on, pick your support email and save. Email/password stays as a backup in case Google sign-in misbehaves inside the home-screen app.
4. **Create the database:** go to *Build → Firestore Database → Create database*.
   - Location: choose **europe-west2 (London)**.
   - Start in **production mode**.
5. **Lock it down to just you two:** in Firestore, open the **Rules** tab. Paste in the contents of `firestore.rules`, replace the two example emails with your real ones, then click **Publish**.

## 2. Get the app's Firebase config (about 2 min)

1. In Firebase, go to *Project settings* (the cog icon) → *Your apps* and click the **</>** (Web) icon.
2. Name it `meal-planner`. You **don't** need Firebase Hosting, so leave that unticked.
3. Firebase will show a `firebaseConfig = { ... }` block. Copy it into `firebase-config.js`, in place of `null`:

```js
export const firebaseConfig = {
  apiKey: "…",
  authDomain: "…",
  projectId: "…",
  storageBucket: "…",
  messagingSenderId: "…",
  appId: "…"
};
```

These values are safe to put on a public website. What keeps your data private is the security rules from step 1.5.

## 3. Put it on GitHub Pages (about 5 min)

1. On GitHub, create a new repository, e.g. `meal-planner`. It can be public or private (Pages on a private repo needs a paid plan, so public is simplest).
2. Upload **all the files in this folder**, including the `icons` folder, to the repo's main branch.
3. Go to *Settings → Pages*. Under *Source*, choose **Deploy from a branch**, pick **main** and **/ (root)**, then click Save.
4. After about a minute the app will be at `https://YOUR-USERNAME.github.io/meal-planner/`.
5. Back in Firebase, go to *Authentication → Settings → Authorised domains* and add `YOUR-USERNAME.github.io`.

## 4. Set up each phone (about 2 min each)

1. Open the link on the phone **while you have signal**.
2. The first time, tap **"First time? Create an account"** and use one of the two emails you put in the rules.
3. The first person to sign in will see **Import my spreadsheet plan**. Tap it to load your 18 meals, 64 ingredients and the 3-week rotation.
4. **Add it to the home screen:**
   - **iPhone (Safari):** tap Share → *Add to Home Screen*.
   - **Android (Chrome):** tap ⋮ → *Install app* (or *Add to Home screen*).
5. Open it once from the home screen icon. That's it: from now on it opens and works with no signal.

---

## How you'll use it

- **Plan:** choose a meal for each day of each week. "Every day" is for things like Breakfast.
- **Meals:** tick which ingredients each meal uses. Search, or type a new ingredient to add it. *Ingredients* lets you rename things and move them between aisles. *Aisles & settings* lets you reorder aisles to match how you walk round the shop.
- **Stock:** for the week you're shopping for, tap anything that's already in the cupboard.
- **Shop:** shows everything you need that isn't in the cupboard, grouped by aisle. Tap to tick items off, and add one-off extras at the top. **Finish shop** clears everything and moves on to the next week.

### No signal?
Everything still works: ticks, the stock check and edits are saved on the phone. The badge at the top shows **Offline · saved on phone**. When signal comes back, changes sync automatically and the badge shows **Synced ✓**. If you're both shopping and ticking at the same time, it just merges: ticking different items never clashes.

### Updating the app later
If you (or I) change any app files, upload them to GitHub, and also change `VERSION` at the top of `sw.js` (e.g. `v1` → `v2`). Phones pick up the new version the next time the app is opened with signal, and use it from the following open.

### Backups
*Meals → Aisles & settings → Download a backup* saves everything as a file.
