# Image fixtures

## rotation.avif

`test_rot.avif` from github.com/gen2brain/avif v0.6.0 (MIT License,
Copyright (c) 2024 gen2brain). It stores a 640x480 AVIF with a 90-degree
container rotation, so the decoded image is 480x640.

## ICC profiles

`srgb.icc`, `display-p3.icc`, and `rgb-lut.icc` are synthetic profiles generated
by `scripts/build-color.mjs` with LittleCMS 2.20. Display P3 uses its D65 white
point, published RGB primaries, and the sRGB transfer curve. The RGB LUT
profile maps every input to a constant PCS value to detect ignored lookup
tables. Creation timestamps are fixed; no user or device data is embedded.
