#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN

@interface ObjCExceptionCatcher : NSObject
+ (BOOL)tryBlock:(void(NS_NOESCAPE ^)(void))block;
+ (void)drawAttributedString:(NSAttributedString *)str atPoint:(NSPoint)point;
@end

NS_ASSUME_NONNULL_END
