# Image fixtures

## rotation.avif

`test_rot.avif` from github.com/gen2brain/avif v0.6.0 (MIT License,
Copyright (c) 2024 gen2brain). It stores a 640x480 AVIF with a 90-degree
container rotation, so the decoded image is 480x640.

## animated.jxl

`test.jxl` from github.com/gen2brain/jpegxl v0.6.0 (MIT License,
Copyright (c) 2024 gen2brain). It is an animated JPEG XL file whose bundled
decoder returns 48 frames. The animation regression uses it to check detection,
the still-export guard, and that an explicit first-frame export matches the
decoder's first frame.

## ICC profiles

`srgb.icc`, `display-p3.icc`, and `rgb-lut.icc` are synthetic profiles generated
by `scripts/build-color.mjs` with LittleCMS 2.20. Display P3 uses its D65 white
point, published RGB primaries, and the sRGB transfer curve. The RGB LUT
profile maps every input to a constant PCS value to detect ignored lookup
tables. Creation timestamps are fixed; no user or device data is embedded.
