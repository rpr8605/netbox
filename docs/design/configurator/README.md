# Configurator design references

These eight files are the approved design for the Beacon Relay Configurator (v1, 2026-09-23).
They are **reference markup, not production code**. They were made in a design canvas and use a
design runtime (`support.js`, `<x-dc>`) that is not part of this repo, so they will not render
correctly if opened directly in a browser. Use the pictures in `docs/design/screens/` to see them.

How to use them:
- Read them for exact layout, spacing, colors, copy, fields and options on each screen.
- Inline `style="..."` attributes are the source of truth for visual values.
- Every hospital name, IP address, serial number and channel name is sample data. Do not ship it.
- The look matches the tech console (`docs/design/tech-console/`).

| File | Screen | Picture |
|---|---|---|
| `Main.dc.html` | Step 1: Site and hardware | `screens/Configurator/Configurator_01_Site_and_hardware.png` |
| `Clinical.dc.html` | Step 2: Clinical systems | `screens/Configurator/Configurator_02_Clinical_systems.png` |
| `Network.dc.html` | Step 3: Network and ports | `screens/Configurator/Configurator_03_Network_and_ports.png` |
| `Security.dc.html` | Step 4: Security and enrollment | `screens/Configurator/Configurator_04_Security_and_enrollment.png` |
| `Build.dc.html` | Step 5: Review and build | `screens/Configurator/Configurator_05_Review_and_build.png` |
| `Flash.dc.html` | Step 6: Flash and verify | `screens/Configurator/Configurator_06_Flash_and_verify.png` |
| `Disks.dc.html` | Drive tools | `screens/Configurator/Configurator_07_Drive_tools.png` |
| `Profiles.dc.html` | Profiles and history | `screens/Configurator/Configurator_08_Profiles_and_history.png` |
