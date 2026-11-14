//go:build darwin && cgo

#import <Cocoa/Cocoa.h>
#include <stdint.h>

extern void picPiperTrayFiles(uintptr_t, const char *);

static NSView *PPFindButton(NSView *view, NSString *tooltip) {
    if ([view isKindOfClass:NSClassFromString(@"NSStatusBarButton")] && [[view toolTip] isEqualToString:tooltip]) return view;
    for (NSView *child in [view subviews]) { NSView *found = PPFindButton(child, tooltip); if (found) return found; }
    return nil;
}
static NSArray *PPURLs(NSPasteboard *pasteboard) {
    return [pasteboard readObjectsForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}];
}
// Status-item drags can arrive at NSStatusBarWindow rather than its button.
// NSWindow forwards drag messages to its delegate when registered. Keep the
// native button (including MyGo's appearance observer) entirely intact.
@interface PPTrayDropReceiver : NSObject <NSWindowDelegate, NSDraggingDestination>
@property(retain) NSWindow *window;
@property(retain) id previousDelegate;
@property(assign) uintptr_t handle;
@end

@implementation PPTrayDropReceiver
- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)info {
    return [PPURLs([info draggingPasteboard]) count] ? NSDragOperationCopy : NSDragOperationNone;
}
- (NSDragOperation)draggingUpdated:(id<NSDraggingInfo>)info { return [self draggingEntered:info]; }
- (BOOL)prepareForDragOperation:(id<NSDraggingInfo>)info { return [self draggingEntered:info] != NSDragOperationNone; }
- (BOOL)performDragOperation:(id<NSDraggingInfo>)info {
    NSMutableArray *paths = [NSMutableArray array];
    for (NSURL *url in PPURLs([info draggingPasteboard])) { if ([url isFileURL] && [url path]) [paths addObject:[url path]]; }
    if (!self.handle || !paths.count) return NO;
    NSData *data = [NSJSONSerialization dataWithJSONObject:paths options:0 error:nil];
    if (!data) return NO;
    NSString *json = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    picPiperTrayFiles(self.handle, [json UTF8String]);
    return YES;
}
- (BOOL)respondsToSelector:(SEL)selector {
    return [super respondsToSelector:selector] || [self.previousDelegate respondsToSelector:selector];
}
- (id)forwardingTargetForSelector:(SEL)selector {
    if ([self.previousDelegate respondsToSelector:selector]) return self.previousDelegate;
    return [super forwardingTargetForSelector:selector];
}
- (void)dealloc {
    [_window release];
    [_previousDelegate release];
    [super dealloc];
}
@end
uintptr_t PPInstallTrayDrop(const char *label, uintptr_t handle) {
    @autoreleasepool {
        NSString *tooltip = [NSString stringWithUTF8String:label];
        NSView *button = nil;
        // A destroyed status item can leave a hidden window alive until the
        // autorelease pool drains. Prefer the current visible item on re-enable.
        for (NSWindow *candidate in [NSApp windows]) {
            NSView *found = PPFindButton([candidate contentView], tooltip);
            if (!found) continue;
            if (!button || candidate.isVisible) button = found;
            if (candidate.isVisible) break;
        }
        NSWindow *window = [button window];
        if (!window || [window.delegate isKindOfClass:[PPTrayDropReceiver class]]) return 0;
        PPTrayDropReceiver *receiver = [[PPTrayDropReceiver alloc] init];
        receiver.window = window;
        receiver.previousDelegate = window.delegate;
        receiver.handle = handle;
        window.delegate = receiver;
        [window registerForDraggedTypes:@[NSPasteboardTypeFileURL]];
        return (uintptr_t)receiver;
    }
}
void PPRemoveTrayDrop(uintptr_t value) {
    @autoreleasepool {
        PPTrayDropReceiver *receiver = (PPTrayDropReceiver *)value;
        receiver.handle = 0;
        if (receiver.window.delegate == receiver) {
            [receiver.window unregisterDraggedTypes];
            receiver.window.delegate = receiver.previousDelegate;
        }
        [receiver release];
    }
}
