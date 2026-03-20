#include "ghostty_loader.h"

const char *tabminal_ghostty_framework_name(void) {
    return "GhosttyKit.framework";
}

const char *tabminal_ghostty_executable_name(void) {
    return "GhosttyKit";
}

const char *tabminal_ghostty_remote_output_symbol(void) {
    return "ghostty_surface_process_output";
}
