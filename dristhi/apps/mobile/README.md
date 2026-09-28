# DRISHTI Mobile Field App (Flutter)

Scaffold for the lessee/quarry-operator field app required by the government
brief: GPS-tagged, timestamped, standardized image capture with Block ID and
quarry metadata, plus offline capture and secure sync.

This folder contains a minimal Flutter structure. To generate the full runnable
project:

```bash
flutter create --org org.peoplewave --project-name drishti_mobile .
```

Then merge `lib/main.dart` below and add dependencies in `pubspec.yaml`:
- `camera` — standardized image acquisition
- `geolocator` — GPS tagging
- `http` — sync to the gateway (POST /captures)
- `hive` / `sqflite` — offline capture buffer

## Capture payload (matches gateway POST /captures)
```json
{
  "block_id": "QRY-AMR-2026-0999",
  "quarry_id": "APQRY-0023",
  "source": "mobile",
  "image_ref": "<MinIO object key after upload>",
  "granite_category": "generic"
}
```

## Brand
Uses the PeopleWave logo (place `assets/peoplewave-logo.png`) and the StartupOS
color palette (see `packages/ui/src/styles/tokens.css` for the hex values).
