#!/usr/bin/env bash
set -euo pipefail

# Ensure script always exits 0 — report generation must never fail the workflow
trap 'exit 0' ERR

# --- Constants ---
MAX_TOTAL=60000
TYPECHECK_MAX=20000
TRACE_MAX=5000

# --- Argument parsing ---
JUNIT_FILE=""
TYPECHECK_FILE=""
RUN_LINK=""
TYPECHECK_OUTCOME=""
TEST_OUTCOME=""
OUTPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --junit)
      JUNIT_FILE="$2"
      shift 2
      ;;
    --typecheck)
      TYPECHECK_FILE="$2"
      shift 2
      ;;
    --run-link)
      RUN_LINK="$2"
      shift 2
      ;;
    --typecheck-outcome)
      TYPECHECK_OUTCOME="$2"
      shift 2
      ;;
    --test-outcome)
      TEST_OUTCOME="$2"
      shift 2
      ;;
    --output)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    *)
      echo "::warning::Unknown argument: $1" >&2
      shift
      ;;
  esac
done

# Check for xmllint availability (after arg parsing).
# Setting CI_REPORT_FORCE_GREP=1 lets tests exercise the grep fallback on
# machines where xmllint is installed — the GitHub Actions ubuntu-latest
# image ships without it, so the grep path is what runs in CI.
HAS_XMLLINT=true
if [[ "${CI_REPORT_FORCE_GREP:-}" == "1" ]]; then
  HAS_XMLLINT=false
elif ! command -v xmllint >/dev/null 2>&1; then
  echo "::warning::xmllint not found, falling back to grep-based parsing" >&2
  HAS_XMLLINT=false
fi

# --- Determine overall status ---
if [[ "$TYPECHECK_OUTCOME" == "success" && "$TEST_OUTCOME" == "success" ]]; then
  OVERALL_STATUS="pass"
else
  OVERALL_STATUS="fail"
fi

# --- Helper: strip ANSI escape sequences ---
strip_ansi() {
  sed $'s/\x1b\\[[0-9;]*m//g'
}

# --- Success report generation (Task 2.2) ---
generate_success_report() {
  printf '## CI (test): ✅ All checks passed\n\n[Full run details](%s)\n' "$RUN_LINK"
}

# --- Typecheck section generation (Task 2.3) ---
generate_typecheck_section() {
  # Only include typecheck section if it failed
  if [[ "$TYPECHECK_OUTCOME" != "failure" ]]; then
    return
  fi

  # Handle missing file — distinct from "typecheck ran and failed" because
  # the absence of output implies the step itself never produced output
  # (e.g., command not found, OOM, runner crash). Use a different status so
  # the agent reading this can tell harness failure from type errors.
  if [[ -z "$TYPECHECK_FILE" || ! -f "$TYPECHECK_FILE" ]]; then
    printf '## Typecheck\n\n**Status:** ⚠️ No results\n\nTypecheck output not found. The step exited with failure but produced no output — the typechecker likely never executed. Check the workflow step log for the actual error.\n'
    return
  fi

  # Handle empty file — typechecker started but produced nothing
  if [[ ! -s "$TYPECHECK_FILE" ]]; then
    printf '## Typecheck\n\n**Status:** ⚠️ No results\n\nTypecheck output is empty. The typechecker started but produced no output before exiting — likely a crash.\n'
    return
  fi

  # Read and strip ANSI
  local content
  content=$(strip_ansi < "$TYPECHECK_FILE")

  # Cap at TYPECHECK_MAX
  local content_len=${#content}
  if [[ $content_len -gt $TYPECHECK_MAX ]]; then
    # Count total error lines
    local total_errors
    total_errors=$(printf '%s' "$content" | grep -c "error TS" || true)

    # Truncate: take lines that fit within TYPECHECK_MAX
    local truncated=""
    local char_count=0
    while IFS= read -r line; do
      local line_len=$(( ${#line} + 1 ))  # +1 for newline
      if [[ $(( char_count + line_len )) -gt $TYPECHECK_MAX ]]; then
        break
      fi
      if [[ -n "$truncated" ]]; then
        truncated="${truncated}"$'\n'"${line}"
      else
        truncated="${line}"
      fi
      char_count=$(( char_count + line_len ))
    done <<< "$content"

    local shown_errors
    shown_errors=$(printf '%s' "$truncated" | grep -c "error TS" || true)
    local omitted=$(( total_errors - shown_errors ))

    content="$truncated"
    if [[ $omitted -gt 0 ]]; then
      content="${content}"$'\n'"[${omitted} more errors omitted]"
    fi
  fi

  # Build section
  printf '## Typecheck\n\n**Status:** ❌ Failed\n\n'

  # Wrap in <details> if content exceeds TRACE_MAX chars
  if [[ ${#content} -gt $TRACE_MAX ]]; then
    printf '<details><summary>Typecheck errors (%d chars)</summary>\n\n```\n%s\n```\n\n</details>\n' "${#content}" "$content"
  else
    printf '```\n%s\n```\n' "$content"
  fi
}

# --- JUnit XML parsing and test failure section (Task 2.4) ---

# Parse JUnit XML using xmllint — outputs structured lines to stdout
# Returns 0 on success, 1 on failure
parse_junit_xmllint() {
  local file="$1"

  # Verify the file is valid XML first
  if ! xmllint --noout "$file" 2>/dev/null; then
    return 1
  fi

  # Extract summary counts from testsuites element
  local tests failures skipped
  tests=$(xmllint --xpath 'string(/*[local-name()="testsuites"]/@tests)' "$file" 2>/dev/null || echo "")
  failures=$(xmllint --xpath 'string(/*[local-name()="testsuites"]/@failures)' "$file" 2>/dev/null || echo "")
  skipped=$(xmllint --xpath 'string(/*[local-name()="testsuites"]/@skipped)' "$file" 2>/dev/null || echo "")

  # If we can't even get the tests attribute, this isn't valid JUnit XML
  if [[ -z "$tests" ]]; then
    return 1
  fi

  if [[ -z "$failures" ]]; then failures="0"; fi
  if [[ -z "$skipped" ]]; then skipped="0"; fi
  local passed=$(( tests - failures - skipped ))
  if [[ $passed -lt 0 ]]; then passed=0; fi

  echo "SUMMARY:${passed} passed, ${failures} failed, ${skipped} skipped"

  # Get count of failed testcases
  local fail_count
  fail_count=$(xmllint --xpath 'count(//*[local-name()="testcase"][*[local-name()="failure"]])' "$file" 2>/dev/null || echo "0")
  # fail_count may be a float like "3.0" from xmllint
  fail_count=${fail_count%%.*}
  if [[ -z "$fail_count" || "$fail_count" == "0" ]]; then
    return 0
  fi

  local i=1
  while [[ $i -le $fail_count ]]; do
    local name classname message trace

    name=$(xmllint --xpath "string((//*[local-name()=\"testcase\"][*[local-name()=\"failure\"]])[$i]/@name)" "$file" 2>/dev/null || echo "unknown")
    classname=$(xmllint --xpath "string((//*[local-name()=\"testcase\"][*[local-name()=\"failure\"]])[$i]/@classname)" "$file" 2>/dev/null || echo "unknown")
    message=$(xmllint --xpath "string((//*[local-name()=\"testcase\"][*[local-name()=\"failure\"]])[$i]/*[local-name()=\"failure\"]/@message)" "$file" 2>/dev/null || echo "")
    trace=$(xmllint --xpath "string((//*[local-name()=\"testcase\"][*[local-name()=\"failure\"]])[$i]/*[local-name()=\"failure\"])" "$file" 2>/dev/null || echo "")

    # Encode newlines in trace as \x01 for transport
    local encoded_trace
    encoded_trace=$(printf '%s' "$trace" | tr '\n' $'\x01')

    # Replace pipes in fields to avoid delimiter collision
    name="${name//|/│}"
    classname="${classname//|/│}"
    message="${message//|/│}"

    echo "FAILURE:${name}|${classname}|${message}|${encoded_trace}"

    i=$(( i + 1 ))
  done
}

# Parse JUnit XML using grep/sed fallback (no xmllint dependency)
parse_junit_grep() {
  local file="$1"

  # Basic validation: file should contain XML-like content
  if ! grep -q '<testsuites' "$file" 2>/dev/null; then
    return 1
  fi

  # Extract summary from testsuites element using grep -o (POSIX-compatible)
  local tests failures skipped
  tests=$(grep -o 'tests="[^"]*"' "$file" 2>/dev/null | head -1 | sed 's/tests="//;s/"//' || echo "0")
  failures=$(grep -o 'failures="[^"]*"' "$file" 2>/dev/null | head -1 | sed 's/failures="//;s/"//' || echo "0")
  skipped=$(grep -o 'skipped="[^"]*"' "$file" 2>/dev/null | head -1 | sed 's/skipped="//;s/"//' || echo "0")

  if [[ -z "$tests" ]]; then tests="0"; fi
  if [[ -z "$failures" ]]; then failures="0"; fi
  if [[ -z "$skipped" ]]; then skipped="0"; fi
  local passed=$(( tests - failures - skipped ))
  if [[ $passed -lt 0 ]]; then passed=0; fi

  echo "SUMMARY:${passed} passed, ${failures} failed, ${skipped} skipped"

  # Extract failures using a state machine approach.
  # The `|| [[ -n "$line" ]]` clause handles files without a trailing newline
  # — without it, the loop body never runs on the final unterminated line,
  # which silently drops failure records for single-line JUnit XML.
  local in_failure=false
  local current_name="" current_classname="" current_message="" current_trace=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    # When we're already tracking a failure, drain that first. The line may
    # contain `</failure>` (closing the active failure) followed by new
    # `<testcase>` tags — if we processed those tags before closing, we'd
    # clobber current_name with the NEXT testcase's name and emit the
    # failure record under the wrong test (the original bug surfaced by
    # multi-line traces ending on the same line as a self-closing
    # passing testcase).
    if [[ "$in_failure" == true ]]; then
      if [[ "$line" =~ \</failure\> ]]; then
        # Append pre-close content to trace, then emit. Anything AFTER
        # </failure> on this line is reprocessed below as if it were a
        # fresh line — so a same-line follow-up testcase/failure is still
        # seen.
        local pre_close after_close
        pre_close=$(printf '%s' "$line" | sed 's/<\/failure>.*//')
        after_close=$(printf '%s' "$line" | sed 's/.*<\/failure>//')
        if [[ -n "$pre_close" ]]; then
          if [[ -n "$current_trace" ]]; then
            current_trace="${current_trace}"$'\n'"${pre_close}"
          else
            current_trace="$pre_close"
          fi
        fi
        local encoded_trace
        encoded_trace=$(printf '%s' "$current_trace" | tr '\n' $'\x01')
        echo "FAILURE:${current_name//|/│}|${current_classname//|/│}|${current_message//|/│}|${encoded_trace}"
        in_failure=false
        line="$after_close"
        # fall through to detection on the remainder
      else
        # No close on this line — accumulate the whole line into trace
        if [[ -n "$current_trace" ]]; then
          current_trace="${current_trace}"$'\n'"${line}"
        else
          current_trace="$line"
        fi
        continue
      fi
    fi

    # Detect testcase opening — capture name and classname.
    # The name regex is anchored at `<testcase` so it does not match the
    # substring `name=` inside `classname="..."` (the original bug: bare
    # `name=\"...\"` matched the classname value because `classname`
    # literally ends in `name=`). The anchor also makes single-line XML
    # safe — testsuite's `name=` won't be picked up.
    if [[ "$line" =~ \<testcase[[:space:]] ]]; then
      # Extract name attribute (scoped to the testcase tag)
      if [[ "$line" =~ \<testcase[^\>]*[[:space:]]name=\"([^\"]+)\" ]]; then
        current_name="${BASH_REMATCH[1]}"
      else
        current_name="unknown"
      fi
      # Extract classname attribute
      if [[ "$line" =~ classname=\"([^\"]+)\" ]]; then
        current_classname="${BASH_REMATCH[1]}"
      else
        current_classname="unknown"
      fi
    fi

    # Detect failure opening
    if [[ "$line" =~ \<failure ]]; then
      # Extract message attribute
      if [[ "$line" =~ message=\"([^\"]+)\" ]]; then
        current_message="${BASH_REMATCH[1]}"
      else
        current_message=""
      fi
      in_failure=true
      current_trace=""

      # Check if failure closes on same line (handle BEFORE self-closing
      # check — a `</failure>` always wins over an unrelated `/>` later on
      # the line, e.g. a sibling self-closing passing testcase).
      if [[ "$line" =~ \</failure\> ]]; then
        local content
        content=$(printf '%s' "$line" | sed 's/.*<failure[^>]*>//;s/<\/failure>.*//')
        local encoded_trace
        encoded_trace=$(printf '%s' "$content" | tr '\n' $'\x01')
        echo "FAILURE:${current_name//|/│}|${current_classname//|/│}|${current_message//|/│}|${encoded_trace}"
        in_failure=false
        continue
      fi

      # Check if the failure tag itself is self-closing (<failure ... />)
      # Use a narrow regex so we only match the failure tag's own self-close.
      if [[ "$line" =~ \<failure[^\>]*/\> ]]; then
        local encoded_trace=""
        echo "FAILURE:${current_name//|/│}|${current_classname//|/│}|${current_message//|/│}|${encoded_trace}"
        in_failure=false
        continue
      fi
      continue
    fi

    # Defensive: should be unreachable now that in_failure is drained at
    # the top of the loop. Keep the legacy accumulation path so any path
    # we missed doesn't silently swallow a trace.
    if [[ "$in_failure" == true ]]; then
      if [[ "$line" =~ \</failure\> ]]; then
        # End of failure element — strip the closing tag from this line
        local clean_line
        clean_line=$(printf '%s' "$line" | sed 's/<\/failure>.*//')
        if [[ -n "$clean_line" ]]; then
          if [[ -n "$current_trace" ]]; then
            current_trace="${current_trace}"$'\n'"${clean_line}"
          else
            current_trace="$clean_line"
          fi
        fi
        local encoded_trace
        encoded_trace=$(printf '%s' "$current_trace" | tr '\n' $'\x01')
        echo "FAILURE:${current_name//|/│}|${current_classname//|/│}|${current_message//|/│}|${encoded_trace}"
        in_failure=false
      else
        if [[ -n "$current_trace" ]]; then
          current_trace="${current_trace}"$'\n'"${line}"
        else
          current_trace="$line"
        fi
      fi
    fi
  done < "$file"
}

generate_test_section() {
  # Only include test section if tests failed
  if [[ "$TEST_OUTCOME" != "failure" ]]; then
    return
  fi

  # Handle missing file — distinct from "tests ran and failed" because no
  # results file means the runner didn't execute (command not found, native
  # module crash, OOM, etc.). Use a different status so the agent reading
  # this knows to investigate harness/env, not test code.
  if [[ -z "$JUNIT_FILE" || ! -f "$JUNIT_FILE" ]]; then
    printf '## Tests\n\n**Status:** ⚠️ No results\n\nTest results file not found. The test step exited with failure but produced no results — the test runner did not execute or crashed before reporting. Check the workflow step log for the actual error (e.g., command not found, missing dependency, runner crash).\n'
    return
  fi

  # Handle empty file — runner started but produced nothing
  if [[ ! -s "$JUNIT_FILE" ]]; then
    printf '## Tests\n\n**Status:** ⚠️ No results\n\nTest results file is empty. The test runner started but produced no output before exiting — likely a crash mid-run.\n'
    return
  fi

  # Parse JUnit XML
  local parse_output=""
  local parse_success=false

  if [[ "$HAS_XMLLINT" == true ]]; then
    if parse_output=$(parse_junit_xmllint "$JUNIT_FILE" 2>/dev/null); then
      parse_success=true
    fi
  fi

  if [[ "$parse_success" == false ]]; then
    if parse_output=$(parse_junit_grep "$JUNIT_FILE" 2>/dev/null); then
      parse_success=true
    fi
  fi

  # If both parsers failed, report malformed XML
  if [[ "$parse_success" == false || -z "$parse_output" ]]; then
    printf '## Tests\n\n**Status:** ⚠️ No results\n\nFailed to parse test results (malformed XML). The runner wrote output but it could not be read.\n'
    return
  fi

  # Extract summary line
  local summary_line
  summary_line=$(printf '%s' "$parse_output" | grep "^SUMMARY:" | head -1 | sed 's/^SUMMARY://')

  # If no summary found, report malformed
  if [[ -z "$summary_line" ]]; then
    printf '## Tests\n\n**Status:** ⚠️ No results\n\nFailed to parse test results (malformed XML). The runner wrote output but it could not be read.\n'
    return
  fi

  # Build section header
  printf '## Tests\n\n**Status:** ❌ Failed | %s\n\n### Failed Tests\n\n| Test | File | Error |\n|------|------|-------|\n' "$summary_line"

  # Collect failures for table and traces
  local -a failure_names=()
  local -a failure_files=()
  local -a failure_messages=()
  local -a failure_traces=()

  while IFS= read -r line; do
    if [[ "$line" =~ ^FAILURE: ]]; then
      local data="${line#FAILURE:}"

      # Split on pipe delimiter
      local name classname message encoded_trace
      name=$(printf '%s' "$data" | cut -d'|' -f1)
      classname=$(printf '%s' "$data" | cut -d'|' -f2)
      message=$(printf '%s' "$data" | cut -d'|' -f3)
      encoded_trace=$(printf '%s' "$data" | cut -d'|' -f4-)

      # Decode trace (restore newlines from \x01)
      local trace
      trace=$(printf '%s' "$encoded_trace" | tr $'\x01' '\n')
      # Trim leading/trailing blank lines
      trace=$(printf '%s' "$trace" | sed '/^[[:space:]]*$/d')

      failure_names+=("$name")
      failure_files+=("$classname")
      failure_messages+=("$message")
      failure_traces+=("$trace")

      # Table row — truncate message to 100 chars for table
      local short_message
      short_message=$(printf '%s' "$message" | head -c 100)
      # Escape pipes for markdown table
      short_message="${short_message//|/\\|}"
      local safe_name="${name//|/\\|}"

      printf '| %s | %s | %s |\n' "$safe_name" "$classname" "$short_message"
    fi
  done <<< "$parse_output"

  # Build failure details section with traces
  local has_traces=false
  local traces_output=""

  for i in "${!failure_names[@]}"; do
    local trace="${failure_traces[$i]}"
    if [[ -n "$trace" ]]; then
      has_traces=true
      local trace_len=${#trace}
      local file="${failure_files[$i]}"
      local name="${failure_names[$i]}"

      local trace_block
      if [[ $trace_len -gt $TRACE_MAX ]]; then
        trace_block=$(printf '#### %s > %s\n\n<details><summary>Stack trace (%d chars)</summary>\n\n```\n%s\n```\n\n</details>' "$file" "$name" "$trace_len" "${trace:0:$TRACE_MAX}")
      else
        trace_block=$(printf '#### %s > %s\n\n```\n%s\n```' "$file" "$name" "$trace")
      fi
      traces_output="${traces_output}${trace_block}"$'\n\n'
    fi
  done

  if [[ "$has_traces" == true ]]; then
    printf '\n### Failure Details\n\n%s' "$traces_output"
  fi
}

# --- Truncation algorithm (Task 2.5) ---
apply_truncation() {
  local report="$1"
  local total_len=${#report}

  if [[ $total_len -le $MAX_TOTAL ]]; then
    printf '%s' "$report"
    return
  fi

  local truncation_notice
  truncation_notice=$(printf '\n---\n⚠️ Report truncated (exceeded 60,000 char limit). See [full run details](%s) for complete output.\n' "$RUN_LINK")

  local notice_len=${#truncation_notice}
  local budget=$(( MAX_TOTAL - notice_len ))

  # Strategy: progressively remove content from lowest priority
  # Priority: (1) header+link, (2) test summary table, (3) typecheck, (4) traces

  # Step 1: Try removing "### Failure Details" section (traces — lowest priority)
  local without_traces="$report"
  if printf '%s' "$report" | grep -q "^### Failure Details"; then
    without_traces=$(printf '%s' "$report" | sed '/^### Failure Details$/,$d')
  fi

  if [[ ${#without_traces} -le $budget ]]; then
    printf '%s%s' "$without_traces" "$truncation_notice"
    return
  fi

  # Step 2: Truncate typecheck section content
  local current="$without_traces"
  if printf '%s' "$current" | grep -q "^## Typecheck"; then
    # Extract everything before typecheck
    local before_tc
    before_tc=$(printf '%s' "$current" | sed '/^## Typecheck$/,$d')

    # Extract typecheck section (up to next ## header or end)
    local tc_section
    tc_section=$(printf '%s' "$current" | sed -n '/^## Typecheck$/,/^## [^#]/{ /^## [^#T]/!p }')

    # Extract everything after typecheck section (next ## header onwards)
    local after_tc=""
    local found_next=false
    while IFS= read -r line; do
      if [[ "$found_next" == true ]]; then
        if [[ -n "$after_tc" ]]; then
          after_tc="${after_tc}"$'\n'"${line}"
        else
          after_tc="${line}"
        fi
      elif [[ "$line" =~ ^##\  ]] && [[ ! "$line" =~ ^##\ Typecheck ]]; then
        # Check if this is after the typecheck section
        if printf '%s' "$current" | sed -n '/^## Typecheck$/,$p' | grep -q "^${line}$"; then
          found_next=true
          after_tc="${line}"
        fi
      fi
    done <<< "$current"

    # Simpler approach: truncate typecheck to first 20 lines of content
    local tc_truncated
    tc_truncated=$(printf '%s' "$tc_section" | head -20)
    tc_truncated="${tc_truncated}"$'\n'"[typecheck output truncated]"

    current="${before_tc}${tc_truncated}"
    if [[ -n "$after_tc" ]]; then
      current="${current}"$'\n'"${after_tc}"
    fi
  fi

  if [[ ${#current} -le $budget ]]; then
    printf '%s%s' "$current" "$truncation_notice"
    return
  fi

  # Step 3: Truncate test table to first 50 rows
  if printf '%s' "$current" | grep -q "^### Failed Tests"; then
    local before_table
    before_table=$(printf '%s' "$current" | sed '/^### Failed Tests$/,$d')

    local table_and_after
    table_and_after=$(printf '%s' "$current" | sed -n '/^### Failed Tests$/,$p')

    # Keep header lines (### Failed Tests, blank, | header |, |---|, then 50 data rows)
    local table_truncated
    table_truncated=$(printf '%s' "$table_and_after" | head -54)
    table_truncated="${table_truncated}"$'\n'"[test results truncated]"

    current="${before_table}${table_truncated}"
  fi

  if [[ ${#current} -le $budget ]]; then
    printf '%s%s' "$current" "$truncation_notice"
    return
  fi

  # Final fallback: hard truncate to budget
  printf '%s%s' "${current:0:$budget}" "$truncation_notice"
}

# --- Report assembly (Task 2.6) ---
generate_failure_report() {
  # Build header section (priority 1) — status + run link in first 5 lines
  local header
  header=$(printf '## CI (test): ❌ Checks failed\n\n**Run:** [%s](%s)\n' "$RUN_LINK" "$RUN_LINK")

  # Req 9.1: If both inputs are entirely missing, produce minimal report
  local tc_missing=false
  local junit_missing=false
  [[ -z "$TYPECHECK_FILE" || ! -f "$TYPECHECK_FILE" ]] && tc_missing=true
  [[ -z "$JUNIT_FILE" || ! -f "$JUNIT_FILE" ]] && junit_missing=true
  if [[ "$tc_missing" == true && "$junit_missing" == true ]]; then
    printf '%s\n\nCI ran but produced no parseable output. See [full run details](%s).\n' "$header" "$RUN_LINK"
    return
  fi

  # Build typecheck section (priority 3)
  local typecheck_section
  typecheck_section=$(generate_typecheck_section)

  # Build test section (priority 2 for table, priority 4 for traces)
  local test_section
  test_section=$(generate_test_section)

  # Assemble full report
  local report="$header"
  if [[ -n "$typecheck_section" ]]; then
    report="${report}"$'\n\n'"${typecheck_section}"
  fi
  if [[ -n "$test_section" ]]; then
    report="${report}"$'\n\n'"${test_section}"
  fi

  # Apply truncation
  apply_truncation "$report"
}

# --- Main ---
main() {
  local report=""

  if [[ "$OVERALL_STATUS" == "pass" ]]; then
    report=$(generate_success_report)
  else
    report=$(generate_failure_report)
  fi

  # Write output
  if [[ -n "$OUTPUT_FILE" ]]; then
    printf '%s\n' "$report" > "$OUTPUT_FILE"
  else
    printf '%s\n' "$report"
  fi
}

main
