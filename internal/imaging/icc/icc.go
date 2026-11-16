// Package icc converts embedded RGB ICC profiles through an isolated LittleCMS
// module. The bundled WASM engine also works in builds without cgo.
package icc

import (
	"context"
	_ "embed"
	"fmt"
	"image"
	"image/color"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

//go:embed lcms.wasm
var engine []byte

var compiled struct {
	sync.Once
	runtime wazero.Runtime
	module  wazero.CompiledModule
	err     error
}

func instantiate(ctx context.Context) (api.Module, error) {
	compiled.Do(func() {
		// Keep shared compilation independent of a caller's cancellation. Each
		// transform gets its own memory, allocator and LittleCMS global state.
		compileCtx := context.Background()
		compiled.runtime = wazero.NewRuntimeWithConfig(compileCtx, wazero.NewRuntimeConfig().WithMemoryLimitPages(1024).WithCloseOnContextDone(true))
		if _, compiled.err = wasi_snapshot_preview1.Instantiate(compileCtx, compiled.runtime); compiled.err == nil {
			compiled.module, compiled.err = compiled.runtime.CompileModule(compileCtx, engine)
		}
	})
	if compiled.err != nil {
		return nil, compiled.err
	}
	return compiled.runtime.InstantiateModule(ctx, compiled.module, wazero.NewModuleConfig().WithName("").WithStartFunctions("_initialize"))
}

func call(ctx context.Context, m api.Module, name string, args ...uint64) (uint32, error) {
	result, err := m.ExportedFunction(name).Call(ctx, args...)
	if err != nil {
		return 0, err
	}
	if len(result) == 0 {
		return 0, nil
	}
	return uint32(result[0]), nil
}

// Normalize converts RGB samples to sRGB while retaining alpha and 16-bit
// precision. Invalid and non-RGB profiles are rejected rather than stripped.
func Normalize(ctx context.Context, src image.Image, profile []byte, sixteenBit bool) (image.Image, error) {
	if len(profile) == 0 || len(profile) > 4<<20 {
		return nil, fmt.Errorf("invalid ICC profile size")
	}
	m, err := instantiate(ctx)
	if err != nil {
		return nil, err
	}
	defer m.Close(context.Background())
	ptr, err := call(ctx, m, "malloc", uint64(len(profile)))
	if err != nil {
		return nil, err
	}
	if ptr == 0 {
		return nil, fmt.Errorf("could not allocate ICC profile")
	}
	if !m.Memory().Write(ptr, profile) {
		return nil, fmt.Errorf("could not write ICC profile")
	}
	depth, pixelBytes := uint64(8), 4
	bounds := image.Rect(0, 0, src.Bounds().Dx(), src.Bounds().Dy())
	var output image.Image
	if sixteenBit {
		depth, pixelBytes = 16, 8
		output = image.NewNRGBA64(bounds)
	} else {
		output = image.NewNRGBA(bounds)
	}
	transform, err := call(ctx, m, "pp_transform", uint64(ptr), uint64(len(profile)), depth)
	if err != nil {
		return nil, err
	}
	if transform == 0 {
		return nil, fmt.Errorf("could not convert the embedded RGB ICC profile")
	}
	defer call(context.Background(), m, "pp_close", uint64(transform))
	if _, err = call(ctx, m, "free", uint64(ptr)); err != nil {
		return nil, err
	}
	const blockPixels = 4096
	inputPtr, err := call(ctx, m, "malloc", uint64(blockPixels*pixelBytes*2))
	if err != nil {
		return nil, err
	}
	if inputPtr == 0 {
		return nil, fmt.Errorf("could not allocate ICC pixel buffer")
	}
	outputPtr := inputPtr + uint32(blockPixels*pixelBytes)
	input := make([]byte, blockPixels*pixelBytes)
	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x += blockPixels {
			if err = ctx.Err(); err != nil {
				return nil, err
			}
			count := min(blockPixels, bounds.Dx()-x)
			for n := 0; n < count; n++ {
				at := src.At(src.Bounds().Min.X+x+n, src.Bounds().Min.Y+y)
				if sixteenBit {
					c := color.NRGBA64Model.Convert(at).(color.NRGBA64)
					i := n * 8
					input[i], input[i+1] = byte(c.R>>8), byte(c.R)
					input[i+2], input[i+3] = byte(c.G>>8), byte(c.G)
					input[i+4], input[i+5] = byte(c.B>>8), byte(c.B)
					input[i+6], input[i+7] = byte(c.A>>8), byte(c.A)
				} else {
					c := color.NRGBAModel.Convert(at).(color.NRGBA)
					i := n * 4
					input[i], input[i+1], input[i+2], input[i+3] = c.R, c.G, c.B, c.A
				}
			}
			if !m.Memory().Write(inputPtr, input[:count*pixelBytes]) {
				return nil, fmt.Errorf("ICC input buffer is unavailable")
			}
			if _, err = call(ctx, m, "pp_apply", uint64(transform), uint64(inputPtr), uint64(outputPtr), uint64(count)); err != nil {
				return nil, err
			}
			converted, ok := m.Memory().Read(outputPtr, uint32(count*pixelBytes))
			if !ok {
				return nil, fmt.Errorf("ICC output buffer is unavailable")
			}
			switch dst := output.(type) {
			case *image.NRGBA:
				copy(dst.Pix[dst.PixOffset(x, y):], converted)
			case *image.NRGBA64:
				copy(dst.Pix[dst.PixOffset(x, y):], converted)
			}
		}
	}
	return output, nil
}
