#import "ObjCExceptionCatcher.h"

@implementation ObjCExceptionCatcher

+ (BOOL)tryBlock:(void(NS_NOESCAPE ^)(void))block {
    @try {
        block();
        return YES;
    } @catch (NSException *e) {
        return NO;
    }
}

+ (void)drawAttributedString:(NSAttributedString *)str atPoint:(NSPoint)point {
    @try {
        [str drawAtPoint:point];
    } @catch (NSException *e) {
        // CoreText nil-font crash on macOS 26 after sleep/wake — silently skip
    }
}

@end
