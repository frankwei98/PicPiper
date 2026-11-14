//go:build darwin && cgo

#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include <stdint.h>

extern void picPiperTrayFiles(uintptr_t, const char *);
static char PPHandleKey, PPClassKey;

static NSView *PPFindButton(NSView *view, NSString *tooltip) {
    if ([view isKindOfClass:NSClassFromString(@"NSStatusBarButton")] && [[view toolTip] isEqualToString:tooltip]) return view;
    for (NSView *child in [view subviews]) { NSView *found = PPFindButton(child, tooltip); if (found) return found; }
    return nil;
}
static NSArray *PPURLs(NSPasteboard *pasteboard) {
    return [pasteboard readObjectsForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}];
}
static NSDragOperation PPEntered(id self, SEL cmd, id<NSDraggingInfo> info) {
    return [PPURLs([info draggingPasteboard]) count] ? NSDragOperationCopy : NSDragOperationNone;
}
static BOOL PPPrepare(id self, SEL cmd, id<NSDraggingInfo> info) { return PPEntered(self, cmd, info) != NSDragOperationNone; }
static BOOL PPPerform(id self, SEL cmd, id<NSDraggingInfo> info) {
    NSMutableArray *paths = [NSMutableArray array];
    for (NSURL *url in PPURLs([info draggingPasteboard])) { if ([url isFileURL] && [url path]) [paths addObject:[url path]]; }
    NSNumber *handle = objc_getAssociatedObject(self, &PPHandleKey);
    if (!handle || !paths.count) return NO;
    NSData *data = [NSJSONSerialization dataWithJSONObject:paths options:0 error:nil];
    NSString *json = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] autorelease];
    picPiperTrayFiles([handle unsignedLongLongValue], [json UTF8String]);
    return YES;
}
uintptr_t PPInstallTrayDrop(const char *label, uintptr_t handle) {
    @autoreleasepool {
        NSString *tooltip = [NSString stringWithUTF8String:label];
        NSView *button = nil;
        for (NSWindow *window in [NSApp windows]) { button = PPFindButton([window contentView], tooltip); if (button) break; }
        if (!button) return 0;
        // Subclass the actual runtime class so AppKit's KVO behavior is retained.
        Class original = object_getClass(button);
        NSString *name = [@"PicPiperDrop_" stringByAppendingString:NSStringFromClass(original)];
        Class subclass = NSClassFromString(name);
        if (!subclass) {
            subclass = objc_allocateClassPair(original, name.UTF8String, 0);
            class_addMethod(subclass, @selector(draggingEntered:), (IMP)PPEntered, "Q@:@");
            class_addMethod(subclass, @selector(draggingUpdated:), (IMP)PPEntered, "Q@:@");
            class_addMethod(subclass, @selector(prepareForDragOperation:), (IMP)PPPrepare, "B@:@");
            class_addMethod(subclass, @selector(performDragOperation:), (IMP)PPPerform, "B@:@");
            objc_registerClassPair(subclass);
        }
        objc_setAssociatedObject(button, &PPClassKey, [NSValue valueWithPointer:original], OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        objc_setAssociatedObject(button, &PPHandleKey, @(handle), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        object_setClass(button, subclass);
        [button registerForDraggedTypes:@[NSPasteboardTypeFileURL]];
        return (uintptr_t)[button retain];
    }
}
void PPRemoveTrayDrop(uintptr_t value) {
    @autoreleasepool {
        NSView *button = (NSView *)value;
        [button unregisterDraggedTypes];
        Class original = [objc_getAssociatedObject(button, &PPClassKey) pointerValue];
        if (original) object_setClass(button, original);
        objc_setAssociatedObject(button, &PPHandleKey, nil, OBJC_ASSOCIATION_ASSIGN);
        objc_setAssociatedObject(button, &PPClassKey, nil, OBJC_ASSOCIATION_ASSIGN);
        [button release];
    }
}
