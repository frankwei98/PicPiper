//go:build cgo && nativeavif

package imaging

/*
#include <avif/avif.h>

// Only the RGB-to-YUV conversion reads Go memory, synchronously. Encoded planes
// and the returned buffer are owned by libavif, never by the Go image.
static avifResult picpiper_encode_avif(const uint8_t* pixels, int width, int height,
                                     int stride, int quality, avifRWData* output) {
  avifImage* image = avifImageCreate(width, height, 8, AVIF_PIXEL_FORMAT_YUV444);
  if (!image) return AVIF_RESULT_OUT_OF_MEMORY;
  image->colorPrimaries = AVIF_COLOR_PRIMARIES_BT709;
  image->transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_SRGB;
  image->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_BT601;
  avifRGBImage rgb;
  avifRGBImageSetDefaults(&rgb, image);
  rgb.pixels = (uint8_t*)pixels;
  rgb.rowBytes = stride;
  rgb.maxThreads = 1;
  // NRGBA supplies straight alpha, avoiding a lossy premultiply/unpremultiply.
  rgb.alphaPremultiplied = AVIF_FALSE;
  avifResult result = avifImageRGBToYUV(image, &rgb);
  if (result != AVIF_RESULT_OK) {
    avifImageDestroy(image);
    return result;
  }
  avifEncoder* encoder = avifEncoderCreate();
  if (!encoder) {
    avifImageDestroy(image);
    return AVIF_RESULT_OUT_OF_MEMORY;
  }
  encoder->codecChoice = AVIF_CODEC_CHOICE_AOM;
  encoder->quality = quality;
  encoder->qualityAlpha = 100;
  encoder->speed = 6;
  // Two isolated workers already bound application-level concurrency.
  encoder->maxThreads = 2;
  // Lossless alpha benefits greatly from more search than speed 6 provides.
  result = avifEncoderSetCodecSpecificOption(encoder, "alpha:cpu-used", "5");
  if (result == AVIF_RESULT_OK) result = avifEncoderWrite(encoder, image, output);
  avifEncoderDestroy(encoder);
  avifImageDestroy(image);
  return result;
}
*/
import "C"

import (
	"fmt"
	"image"
	"image/draw"
	"io"
	"runtime"
	"unsafe"
)

func encodeAVIF(writer io.Writer, img image.Image, quality int) error {
	bounds := img.Bounds()
	if bounds.Empty() || bounds.Dx() > 65536 || bounds.Dy() > 65536 || int64(bounds.Dx())*int64(bounds.Dy()) > maxPixels {
		return fmt.Errorf("image dimensions exceed AVIF limits")
	}
	pixels, ok := img.(*image.NRGBA)
	if !ok {
		pixels = image.NewNRGBA(bounds)
		draw.Draw(pixels, bounds, img, bounds.Min, draw.Src)
	}
	var output C.avifRWData
	defer C.avifRWDataFree(&output)
	result := C.picpiper_encode_avif((*C.uint8_t)(unsafe.Pointer(&pixels.Pix[0])),
		C.int(bounds.Dx()), C.int(bounds.Dy()), C.int(pixels.Stride), C.int(quality), &output)
	runtime.KeepAlive(pixels)
	if result != C.AVIF_RESULT_OK {
		return fmt.Errorf("native AVIF encoding failed: %s", C.GoString(C.avifResultToString(result)))
	}
	data := unsafe.Slice((*byte)(unsafe.Pointer(output.data)), int(output.size))
	written, err := writer.Write(data)
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	return err
}
