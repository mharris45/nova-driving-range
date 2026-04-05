# Nova Driving Range

A Chrome extension that adds a 3D driving range visualization overlay to the [OpenLaunch](https://dashboard.openlaunch.io/) launch monitor dashboard. Captures live shot data, displays ball flight trajectories in 3D, and logs every shot to a local CSV.

## What It Does

- **3D Shot Replay** — Renders ball flight trajectories with bounce and roll using Three.js, complete with a procedural sky, grass, and yardage markers
- **Live Data Capture** — Intercepts shot data from the OpenLaunch Firestore stream in real time (ball speed, launch angles, spin, carry, etc.)
- **Club Selection** — Choose your club (Driver through SW) before saving each shot; the first column in the CSV
- **Auto-Save to CSV** — Every shot is automatically saved to a CSV file in your Downloads folder (configurable filename in extension settings)
- **Landing Dots** — Shows the last 100 carry distance landing points for the selected club on the 3D range, fading older shots for a heat-map effect
- **Shot Grading** — Displays shot type classification and rank (S/A/B/C/D) from the OpenGolf Coach when available, with confetti for S-rank shots
- **Editable Metrics** — Manually adjust any shot metric and see the trajectory update in real time

## Setup

### Prerequisites
- Google Chrome (or any Chromium-based browser)
- An [OpenLaunch](https://openlaunch.io/) compatible launch monitor

### Installation

1. Clone or download this repository
   ```
   git clone https://github.com/your-username/nova-driving-range.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `nova-driving-range` folder
5. Right-click the extension icon → **Options** and set your CSV filename (default: `nova-shots.csv` in your Downloads folder)
6. Navigate to [dashboard.openlaunch.io](https://dashboard.openlaunch.io/) and sign in

### Usage

1. Hit a shot on your launch monitor — data appears automatically on the OpenLaunch dashboard
2. Every shot is **automatically saved** to the configured CSV file in your Downloads folder
3. Click the **⛳** button in the bottom-right corner to open the 3D overlay
4. Select your **club** from the dropdown in the header bar (first column in the CSV)
5. Use **REPLAY** to re-watch the ball flight animation
6. Click **EDIT SHOT DATA** at the bottom to manually adjust any metric

### CSV Columns

| Column | Description |
|--------|-------------|
| Club | Selected club (Driver, 3W, 5W, ... PW, GW, SW) |
| Timestamp | ISO 8601 date/time |
| BallSpeed | mph |
| vLaunchAngle | Vertical launch angle (degrees) |
| hLaunchAngle | Horizontal launch angle (degrees) |
| CarryDist | Carry distance (yards) |
| TotalDist | Total distance including roll (yards) |
| OfflineDist | Offline/lateral distance (yards) |
| PeakHeight | Peak height (yards) |
| HangTime | Hang time (seconds) |
| TotalSpin | Total spin (rpm) |
| Backspin | Backspin component (rpm) |
| Sidespin | Sidespin component (rpm) |
| SpinAxis | Spin axis (degrees) |
| ClubSpeed | Club head speed (mph) |
| SmashFactor | Ball speed / club speed ratio |
| DescentAngle | Descent angle (degrees) |
| DistEfficiency | Distance efficiency (%) |
| ShotName | Shot type classification |
| ShotRank | Shot grade (S/A/B/C/D) |

## Extension Settings

Right-click the extension icon and select **Options** to:
- Set the CSV filename (saves to your Downloads folder)
- View total saved shot count
- Clear all saved data

## Tech Stack

- **Three.js** — 3D rendering (bundled)
- **Chrome Extension Manifest V3** — content scripts + storage API
- **Firestore stream interception** — captures live shot data without modifying the OpenLaunch app
