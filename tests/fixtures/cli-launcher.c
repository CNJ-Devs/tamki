/* Native Windows launcher for the synthetic Node CLI; never bundled in Tamki. */
#include <windows.h>
#include <stdlib.h>
#include <wchar.h>

static wchar_t *argument(wchar_t *out, const wchar_t *text) {
    *out++ = L'"';
    for (;;) {
        size_t slashes = 0;
        while (*text == L'\\') { slashes++; text++; }
        size_t count = (*text == L'"' || !*text) ? slashes * 2 : slashes;
        while (count--) *out++ = L'\\';
        if (!*text) break;
        if (*text == L'"') *out++ = L'\\';
        *out++ = *text++;
    }
    *out++ = L'"'; *out++ = L' ';
    return out;
}

int wmain(int argc, wchar_t **argv) {
    const wchar_t *node = _wgetenv(L"TAMKI_FIXTURE_NODE");
    wchar_t script[32768];
    if (!node || !GetModuleFileNameW(NULL, script, 32768)) return 125;
    wchar_t *extension = wcsrchr(script, L'.');
    if (!extension) return 125;
    wcscpy(extension, L".mjs");
    size_t capacity = wcslen(node) + wcslen(script) + 16;
    for (int i = 1; i < argc; i++) capacity += wcslen(argv[i]) + 3;
    wchar_t *line = calloc(capacity * 2 + 1, sizeof(wchar_t)), *end = line;
    if (!line) return 125;
    end = argument(end, node); end = argument(end, script);
    for (int i = 1; i < argc; i++) end = argument(end, argv[i]);
    *end = 0;
    STARTUPINFOW startup = {0}; PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (!CreateProcessW(node, line, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &startup, &process)) { free(line); return 125; }
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
        AssignProcessToJobObject(job, process.hProcess);
    }
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 1; GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
    if (job) CloseHandle(job);
    free(line);
    return (int)code;
}
