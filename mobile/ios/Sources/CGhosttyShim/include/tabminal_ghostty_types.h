#ifndef TABMINAL_GHOSTTY_TYPES_H
#define TABMINAL_GHOSTTY_TYPES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define GHOSTTY_SUCCESS 0

typedef void *ghostty_app_t;
typedef void *ghostty_config_t;
typedef void *ghostty_surface_t;

typedef enum {
    GHOSTTY_PLATFORM_INVALID,
    GHOSTTY_PLATFORM_MACOS,
    GHOSTTY_PLATFORM_IOS,
} ghostty_platform_e;

typedef enum {
    GHOSTTY_CLIPBOARD_STANDARD,
    GHOSTTY_CLIPBOARD_SELECTION,
} ghostty_clipboard_e;

typedef struct {
    const char *mime;
    const char *data;
} ghostty_clipboard_content_s;

typedef enum {
    GHOSTTY_CLIPBOARD_REQUEST_PASTE,
    GHOSTTY_CLIPBOARD_REQUEST_OSC_52_READ,
    GHOSTTY_CLIPBOARD_REQUEST_OSC_52_WRITE,
} ghostty_clipboard_request_e;

typedef struct {
    uint64_t words[2];
} ghostty_target_s;

typedef struct {
    uint64_t words[4];
} ghostty_action_s;

typedef struct {
    const char *key;
    const char *value;
} ghostty_env_var_s;

typedef struct {
    void *nsview;
} ghostty_platform_macos_s;

typedef struct {
    void *uiview;
} ghostty_platform_ios_s;

typedef union {
    ghostty_platform_macos_s macos;
    ghostty_platform_ios_s ios;
} ghostty_platform_u;

typedef enum {
    GHOSTTY_SURFACE_CONTEXT_WINDOW = 0,
    GHOSTTY_SURFACE_CONTEXT_TAB = 1,
    GHOSTTY_SURFACE_CONTEXT_SPLIT = 2,
} ghostty_surface_context_e;

typedef struct {
    ghostty_platform_e platform_tag;
    ghostty_platform_u platform;
    void *userdata;
    double scale_factor;
    float font_size;
    const char *working_directory;
    const char *command;
    ghostty_env_var_s *env_vars;
    size_t env_var_count;
    const char *initial_input;
    bool wait_after_command;
    bool manual_io;
    ghostty_surface_context_e context;
} ghostty_surface_config_s;

typedef struct {
    uint16_t columns;
    uint16_t rows;
    uint32_t width_px;
    uint32_t height_px;
    uint32_t cell_width_px;
    uint32_t cell_height_px;
} ghostty_surface_size_s;

typedef void (*ghostty_runtime_wakeup_cb)(void *);
typedef bool (*ghostty_runtime_action_cb)(ghostty_app_t,
                                          ghostty_target_s,
                                          ghostty_action_s);
typedef bool (*ghostty_runtime_read_clipboard_cb)(void *,
                                                  ghostty_clipboard_e,
                                                  void *);
typedef void (*ghostty_runtime_confirm_read_clipboard_cb)(
    void *,
    const char *,
    void *,
    ghostty_clipboard_request_e);
typedef void (*ghostty_runtime_write_clipboard_cb)(
    void *,
    ghostty_clipboard_e,
    const ghostty_clipboard_content_s *,
    size_t,
    bool);
typedef void *ghostty_runtime_close_surface_cb;

typedef struct {
    void *userdata;
    bool supports_selection_clipboard;
    ghostty_runtime_wakeup_cb wakeup_cb;
    ghostty_runtime_action_cb action_cb;
    ghostty_runtime_read_clipboard_cb read_clipboard_cb;
    ghostty_runtime_confirm_read_clipboard_cb confirm_read_clipboard_cb;
    ghostty_runtime_write_clipboard_cb write_clipboard_cb;
    ghostty_runtime_close_surface_cb close_surface_cb;
} ghostty_runtime_config_s;

#endif
