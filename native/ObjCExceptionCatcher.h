#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ObjCExceptionCatcher : NSObject
+ (BOOL)tryBlock:(void(^)(void))block;
@end

NS_ASSUME_NONNULL_END
