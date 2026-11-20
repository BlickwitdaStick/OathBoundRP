# Converts the five variable-length arrays (VLAs, C99) in rnnoise v0.1.1
# to _alloca allocations. The MSVC C compiler does not support VLAs;
# Clang and GCC do.
# Same semantics (stack allocation, released when the function returns),
# without needing to know the upper bound of each array.
#
# Idempotent: after replacement, the old pattern no longer matches.
# Passed as PATCH_COMMAND in FetchContent_Declare(rnnoise ...).

set(_src "${RNNOISE_SRC_DIR}")

function(_patch file)
  set(path "${_src}/src/${file}")
  file(READ "${path}" content)

  # Ensure <malloc.h> is included for _alloca on MSVC.
  if(NOT content MATCHES "#include <malloc.h>")
    set(content "#ifdef _MSC_VER\n#include <malloc.h>\n#endif\n${content}")
  endif()

  string(REPLACE
    "opus_val16 xx[n];"
    "opus_val16 *xx = (opus_val16*)_alloca((n)*sizeof(opus_val16));"
    content "${content}")

  string(REPLACE
    "opus_val16 x_lp4[len>>2];"
    "opus_val16 *x_lp4 = (opus_val16*)_alloca((len>>2)*sizeof(opus_val16));"
    content "${content}")

  string(REPLACE
    "opus_val16 y_lp4[lag>>2];"
    "opus_val16 *y_lp4 = (opus_val16*)_alloca((lag>>2)*sizeof(opus_val16));"
    content "${content}")

  string(REPLACE
    "opus_val32 xcorr[max_pitch>>1];"
    "opus_val32 *xcorr = (opus_val32*)_alloca((max_pitch>>1)*sizeof(opus_val32));"
    content "${content}")

  string(REPLACE
    "opus_val32 yy_lookup[maxperiod+1];"
    "opus_val32 *yy_lookup = (opus_val32*)_alloca((maxperiod+1)*sizeof(opus_val32));"
    content "${content}")

  file(WRITE "${path}" "${content}")
endfunction()

_patch(celt_lpc.c)
_patch(pitch.c)

message(STATUS "rnnoise: VLAs converted to _alloca (MSVC patch)")