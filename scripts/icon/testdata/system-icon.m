#import <Cocoa/Cocoa.h>

// Read IconServices' bundle rendering, rather than the raw PNG/ICNS. Modern
// macOS can put partially transparent artwork inside an extra white tile.
int main(int argc, const char **argv) { @autoreleasepool {
    if (argc != 3) return 2;
    NSString *bundle = [NSString stringWithUTF8String:argv[1]];
    NSImage *icon = [[NSWorkspace sharedWorkspace] iconForFile:bundle];
    NSBitmapImageRep *bitmap = [[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:512 pixelsHigh:512 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0] autorelease];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap]];
    [icon drawInRect:NSMakeRect(0, 0, 512, 512) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1];
    [NSGraphicsContext restoreGraphicsState];
    NSString *snapshot = [NSString stringWithUTF8String:argv[2]];
    if (![[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:snapshot atomically:YES]) {
        fprintf(stderr, "FAIL: could not save system icon snapshot\n");
        return 1;
    }
    for (NSInteger y = 56; y <= 72; y += 8) {
        NSColor *color = [[bitmap colorAtX:256 y:y] colorUsingColorSpace:[NSColorSpace sRGBColorSpace]];
        if (color.alphaComponent < 0.99 || color.redComponent > 0.35 || color.greenComponent > 0.35 || color.blueComponent > 0.35) {
            fprintf(stderr, "FAIL: system-rendered app icon lost its dark tile at (256,%ld): RGBA %.3f %.3f %.3f %.3f\n", (long)y, color.redComponent, color.greenComponent, color.blueComponent, color.alphaComponent);
            return 1;
        }
    }
    puts("PASS: system-rendered app icon retains the dark tile without a white outer frame");
    return 0;
} }
