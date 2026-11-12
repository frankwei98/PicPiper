//go:build cgo && nativewebp

package imaging

/*
#include <webp/encode.h>

// libwebp copies the pixels into picture-owned storage during ImportRGBA.
// No Go pointer is retained after this synchronous call returns.
static int picpiper_encode_webp(const uint8_t* pixels, int width, int height,
                              int stride, int quality, WebPMemoryWriter* output) {
  WebPConfig config;
  WebPPicture picture;
  if (!WebPConfigInit(&config) || !WebPPictureInit(&picture)) return 0;
  config.quality = (float)quality;
  config.method = 4;
  config.exact = 1;
  config.thread_level = 1;
  picture.use_argb = 1;
  picture.width = width;
  picture.height = height;
  picture.writer = WebPMemoryWrite;
  picture.custom_ptr = output;
  WebPMemoryWriterInit(output);
  int ok = WebPPictureImportRGBA(&picture, pixels, stride) && WebPEncode(&config, &picture);
  WebPPictureFree(&picture);
  return ok;
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

func encodeWebP(writer io.Writer, img image.Image, quality int) error {
	bounds := img.Bounds()
	if bounds.Empty() || bounds.Dx() > 16383 || bounds.Dy() > 16383 {
		return fmt.Errorf("image dimensions exceed WebP limits")
	}
	pixels, ok := img.(*image.NRGBA)
	if !ok {
		pixels = image.NewNRGBA(bounds)
		draw.Draw(pixels, bounds, img, bounds.Min, draw.Src)
	}
	var output C.WebPMemoryWriter
	defer C.WebPMemoryWriterClear(&output)
	result := C.picpiper_encode_webp((*C.uint8_t)(unsafe.Pointer(&pixels.Pix[0])),
		C.int(bounds.Dx()), C.int(bounds.Dy()), C.int(pixels.Stride), C.int(quality), &output)
	runtime.KeepAlive(pixels)
	if result == 0 {
		return fmt.Errorf("native WebP encoding failed")
	}
	data := unsafe.Slice((*byte)(unsafe.Pointer(output.mem)), int(output.size))
	written, err := writer.Write(data)
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	return err
}
