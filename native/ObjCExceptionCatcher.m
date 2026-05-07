#import "ObjCExceptionCatcher.h"

@implementation ObjCExceptionCatcher

+ (BOOL)tryBlock:(void(^)(void))block {
    @try {
        block();
        return YES;
    } @catch (NSException *e) {
        return NO;
    }
}

@end
