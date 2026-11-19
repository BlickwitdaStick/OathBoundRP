# Converts the 5 variable-length arrays (VLA, C99) in rnnoise v0.1.1 into
# _alloca allocations. MSVC's C compiler doesn't accept VLAs; clang and gcc do.
# Same semantics (stack, freed when the function returns), without needing to
# know each one's upper bound.
#
# Idempotent: after the replacement the old pattern no longer matches. Passed as
# the PATCH_COMMAND of FetchContent_Declare(rnnoise ...).

set(_src "${RNNOISE_SRC_DIR}")

function(_patch file)
  set(path "${_src}/src/${file}")
  file(READ "${path}" content)
  # ensures <malloc.h> for _alloca on MSVC
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
