#include "ghostty_loader.h"

const char *tabminal_ghostty_framework_name(void) {
    return "GhosttyKit.framework";
}

const char *tabminal_ghostty_executable_name(void) {
    return "GhosttyKit";
}

const char *tabminal_ghostty_feed_data_symbol(void) {
    return "ghostty_surface_feed_data";
}

const char *tabminal_ghostty_write_callback_symbol(void) {
    return "ghostty_surface_set_write_callback";
}
