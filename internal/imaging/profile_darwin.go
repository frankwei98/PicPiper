//go:build darwin && cgo

package imaging

/*
#cgo LDFLAGS: -framework CoreGraphics -framework CoreFoundation
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>

static int normalize_profile(const unsigned char *source, unsigned char *output,
    int width, int height, int depth, const unsigned char *profile, size_t length) {
    CFDataRef data = CFDataCreate(NULL, profile, length);
    if (!data) return 0;
    CGColorSpaceRef inputSpace = CGColorSpaceCreateWithICCData(data);
    CFRelease(data);
    if (!inputSpace || CGColorSpaceGetModel(inputSpace) != kCGColorSpaceModelRGB) {
        if (inputSpace) CGColorSpaceRelease(inputSpace);
        return 0;
    }
    CGColorSpaceRef outputSpace = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    size_t stride = (size_t)width * 4 * (depth / 8);
    CGDataProviderRef provider = CGDataProviderCreateWithData(NULL, source, stride * height, NULL);
    CGBitmapInfo byteOrder = depth == 16 ? kCGBitmapByteOrder16Big : kCGBitmapByteOrder32Big;
    CGImageRef image = CGImageCreate(width, height, depth, depth * 4, stride, inputSpace,
        byteOrder | kCGImageAlphaLast, provider, NULL, false, kCGRenderingIntentRelativeColorimetric);
    CGContextRef context = CGBitmapContextCreate(output, width, height, depth, stride,
        outputSpace, byteOrder | kCGImageAlphaPremultipliedLast);
    int ok = image && context;
    if (ok) {
        CGContextSetBlendMode(context, kCGBlendModeCopy);
        CGContextSetRenderingIntent(context, kCGRenderingIntentRelativeColorimetric);
        CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    }
    if (context) CGContextRelease(context);
    if (image) CGImageRelease(image);
    if (provider) CGDataProviderRelease(provider);
    CGColorSpaceRelease(outputSpace);
    CGColorSpaceRelease(inputSpace);
    return ok;
}

static CFDataRef display_p3_profile(void) {
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceDisplayP3);
    CFDataRef profile = CGColorSpaceCopyICCData(space);
    CGColorSpaceRelease(space);
    return profile;
}
*/
import "C"

import (
	"fmt"
	"image"
	"image/draw"
	"runtime"
	"unsafe"
)

func normalizeProfile(src image.Image, profile []byte) (image.Image, error) {
	bounds := image.Rect(0, 0, src.Bounds().Dx(), src.Bounds().Dy())
	var input, output []byte
	var result draw.Image
	depth := 8
	if highBitDepth(src) {
		depth = 16
		converted := image.NewNRGBA64(bounds)
		draw.Draw(converted, bounds, src, src.Bounds().Min, draw.Src)
		input = converted.Pix
		destination := image.NewRGBA64(bounds)
		output, result = destination.Pix, destination
	} else {
		converted := image.NewNRGBA(bounds)
		draw.Draw(converted, bounds, src, src.Bounds().Min, draw.Src)
		input = converted.Pix
		destination := image.NewRGBA(bounds)
		output, result = destination.Pix, destination
	}
	ok := C.normalize_profile((*C.uchar)(unsafe.Pointer(&input[0])), (*C.uchar)(unsafe.Pointer(&output[0])), C.int(bounds.Dx()), C.int(bounds.Dy()), C.int(depth), (*C.uchar)(unsafe.Pointer(&profile[0])), C.size_t(len(profile)))
	runtime.KeepAlive(input)
	runtime.KeepAlive(output)
	runtime.KeepAlive(profile)
	if ok == 0 {
		return nil, fmt.Errorf("could not convert the embedded RGB profile to sRGB")
	}
	return result, nil
}

func displayP3Profile() []byte {
	data := C.display_p3_profile()
	if data == 0 {
		return nil
	}
	defer C.CFRelease(C.CFTypeRef(data))
	return C.GoBytes(unsafe.Pointer(C.CFDataGetBytePtr(data)), C.int(C.CFDataGetLength(data)))
}
