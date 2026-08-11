[<img src="https://github.com/user-attachments/assets/f32ae56e-248a-4780-9c39-da9c1b17f73e" width="360">](https://shogun160.github.io/TCM-ZEN_DOMIZER/zendomizer.html)

# **Randomizer for The Crew Motorfest Grand Races** *(click picture above to start)*

**Available categories** *(TIP: Sort your vehicles by brand)*  
🚘 Street Tier 1 🚘 Street Tier 2 🚘 Hypercar 🚘 Drift 🚘 Racing 🚘 AGP 🚘 Motocross 🚘 Rally 🚘 Rally Raid 🚘 Monster Truck 🚘

⚠️ *For Drift there are only a few cars available at the moment (Hoonigan & most Mitsubishi). This is because steering will block for most other drift cars when using direct mode or high dynamic maxlock. More cars may be added later.*

Thanks to [@wbcolon](https://github.com/wbcolon) for integrating the Grandrace rotation and automatic matching categories.  
And of course a special thank also to the [motorfe.st project](https://github.com/calamity-inc/motorfe.st/) for the rotation logic itself.

**Version:** v2.7
**Carlist:** Season 10 – 05.10.2026

👉 [Twitch](https://www.twitch.tv/xthepapapyr0) & [Discord](https://discord.gg/mJKXNPTG).

---

## 🔧 Core Features

- 🎰 **random picker** for The Crew Motorfest – perfect for having fun , doing challenges or streams - **keep the experience fresh**
- 🧠 **fully flexible** choose from several filters like country, brand or select just 2 categories to repeat the first selection (Rally --> Rally Raid --> Rally)
- 🔒 **rocking solid** if no filter matches, the filters are ignored one after the other - ignored filters are displayed
- 🏁 **Grandrace rotation** automatic category selection (powered by motorfe.st) - can be de-/actived with the *Grandrace Catgerories* Button - current modifier and grnad race route will also be shown ⚠️ *routes may not always match correctly - in case please deactivate Grandrace Categories Button*
- 🎯 **advanced draw logic** with fallback system – ensures a valid result even with tight filters
- 🔁 **blacklist system** prevents repeats by writing a blacklit to browsers internal storage – with automatic reset when all options are drawn
- ⚙️ **available filters:**
  - 🚗 only cars / 🔝 top tier cars / 🏍️ only bikes / 🚙 all vehicles  
  - 🌍 country  
  - 🏷️ brand  
  - ⏳ era (classic / modern)
- 🧹 **hotkeys for power users**:
  - `Shift + ?` – show help
  - `Shift + R` – reset blacklist & counter  
  - `Shift + X` – clear draw log  
  - `Shift + L` – show draw log in console
  - `Cntrl + C` – copy draw to clipboard again
- 📋 **automatic copy to clipboard** - text output per category
- 🇩🇪/🇬🇧 **multilanguage support** - german/english
- 📲 **support for mobile phones**

---

## 🖼️ Screenshots

### 🏁 Startpage
![Zendomizer Startpage](assets/pic/Zendomizer_startpage.png)

### 🎰 ZENDomizer Selection "Your Pick"
![Zendomizer Clipboard Result](assets/pic/ZENdomizer_selection.png)

### 🎰 ZENDomizer Selection "Your Pick" - only 2 categories selected
![Zendomizer Clipboard Result](assets/pic/ZENdomizer_2cat_selection.png)

### 🎰 ZENDomizer Smart Filters - always get cars and see ignored filters
<img src="assets/pic/ZENdomizer_ignored_filters.png" width="35%">

### Multi language - choose between german and english
![Zendomizer Multi language](assets/pic/ZENdomizer_multilanguage.png)

### 📊 Log (`Shift + L`)
![Zendomizer DevLog](assets/pic/ZENdomizer_DevCon_Log.png)

---

## 🧪 Tests

Draw logic regression tests — plain Node, no dependencies:

```bash
node tests/run.mjs
```

They cut the real functions out of `zendomizer.html` and run them against
`cars/vehicles.json`, so they test the shipped code rather than a copy. Set
`ZENDOMIZER_HTML` to check a different revision, e.g. to confirm a test
actually catches the bug it covers:

```bash
git show HEAD~1:zendomizer.html > /tmp/before.html
ZENDOMIZER_HTML=/tmp/before.html node tests/run.mjs
```

The Twitch worker has its own suite: `cd twitch-bot && npm test`.
