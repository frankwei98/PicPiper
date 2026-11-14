#import <Cocoa/Cocoa.h>
#include <stdint.h>

static NSUInteger deliveries;
static NSArray *deliveredPaths;
static uintptr_t deliveredHandle;

void picPiperTrayFiles(uintptr_t handle, const char *json) {
    deliveries++;
    deliveredHandle = handle;
    [deliveredPaths release];
    deliveredPaths = [[NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil] retain];
}

#include "../drop_darwin.m"

// Replay Finder's file-URL pasteboard through the real NSStatusBarWindow,
// rather than calling the adapter's handler directly. This covers AppKit's
// documented window-to-delegate dispatch, but not a physical Finder gesture.
@interface PPTestDrag : NSObject
@property(retain) NSPasteboard *pasteboard;
@end
@implementation PPTestDrag
- (NSPasteboard *)draggingPasteboard { return self.pasteboard; }
- (void)dealloc { [_pasteboard release]; [super dealloc]; }
@end

@interface PPTestWindowDelegate : NSObject <NSWindowDelegate>
@end
@implementation PPTestWindowDelegate
- (BOOL)windowShouldClose:(NSWindow *)window { return NO; }
@end

static void require(BOOL condition, const char *message) {
    if (!condition) { fprintf(stderr, "FAIL: %s\n", message); exit(1); }
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    NSStatusItem *item = [[[NSStatusBar systemStatusBar] statusItemWithLength:28] retain];
    item.button.title = @"PP";
    item.button.toolTip = @"Pic Piper native drop test";
    NSWindow *window = item.button.window;
    require(window != nil, "native status item has no window");
    PPTestWindowDelegate *previous = [[[PPTestWindowDelegate alloc] init] autorelease];
    window.delegate = previous;

    uintptr_t token = PPInstallTrayDrop("Pic Piper native drop test", 42);
    require(token != 0, "adapter did not attach to native status item");
    require(PPInstallTrayDrop("Pic Piper native drop test", 99) == 0, "duplicate installation replaced a live callback");
    require(PPInstallTrayDrop("no such status item", 99) == 0, "unrelated status item was selected");

    PPTestDrag *drag = [[[PPTestDrag alloc] init] autorelease];
    drag.pasteboard = [NSPasteboard pasteboardWithUniqueName];
    NSArray *paths = @[@"/private/tmp/first image.png", @"/private/tmp/第二张.webp"];
    [drag.pasteboard writeObjects:@[[NSURL fileURLWithPath:paths[0]], [NSURL fileURLWithPath:paths[1]]]];
    id<NSDraggingDestination> destination = (id)window;
    require([destination draggingEntered:(id)drag] == NSDragOperationCopy, "status-item window rejected Finder file URLs before delivery");
    require([destination draggingUpdated:(id)drag] == NSDragOperationCopy, "status-item window stopped accepting file URLs while hovering");
    require([destination prepareForDragOperation:(id)drag], "status-item window rejected drop preparation");
    require([destination performDragOperation:(id)drag], "status-item window did not perform file drop");
    require(deliveries == 1 && deliveredHandle == 42 && [deliveredPaths isEqual:paths], "file paths did not reach the installed callback exactly once");
    require([window.delegate respondsToSelector:@selector(windowShouldClose:)] && ![window.delegate windowShouldClose:window], "existing window delegate stopped receiving callbacks");

    [drag.pasteboard clearContents];
    [drag.pasteboard writeObjects:@[[NSURL URLWithString:@"https://example.invalid/image.png"]]];
    require([destination draggingEntered:(id)drag] == NSDragOperationNone, "remote URLs were accepted as local files");
    require(![destination performDragOperation:(id)drag] && deliveries == 1, "rejected data reached the callback");

    [drag.pasteboard clearContents];
    [drag.pasteboard writeObjects:@[[NSURL fileURLWithPath:paths[0]]]];
    PPRemoveTrayDrop(token);
    require(window.delegate == previous, "cleanup did not restore the previous window delegate");
    require(![destination performDragOperation:(id)drag] && deliveries == 1, "callback remained installed after cleanup");

    token = PPInstallTrayDrop("Pic Piper native drop test", 43);
    require(token != 0, "adapter could not be enabled again");
    [drag.pasteboard clearContents];
    [drag.pasteboard writeObjects:@[[NSURL fileURLWithPath:paths[0]]]];
    require([destination performDragOperation:(id)drag] && deliveries == 2 && deliveredHandle == 43, "re-enabled adapter reused the old callback");
    PPRemoveTrayDrop(token);
    window.delegate = nil;
    [[NSStatusBar systemStatusBar] removeStatusItem:item];
    [item release];

    item = [[[NSStatusBar systemStatusBar] statusItemWithLength:28] retain];
    item.button.title = @"PP";
    item.button.toolTip = @"Pic Piper native drop test";
    token = PPInstallTrayDrop("Pic Piper native drop test", 44);
    require(token != 0, "adapter did not attach after the status item was recreated");
    destination = (id)item.button.window;
    require([destination draggingEntered:(id)drag] == NSDragOperationCopy && [destination performDragOperation:(id)drag] && deliveries == 3 && deliveredHandle == 44, "recreated status item did not deliver file drops");
    PPRemoveTrayDrop(token);
    [[NSStatusBar systemStatusBar] removeStatusItem:item];
    [item release];
    [drag.pasteboard releaseGlobally];
    [deliveredPaths release];
    puts("PASS: native status-window file drop, filtering, delegate forwarding, cleanup and recreation");
    return 0;
} }
