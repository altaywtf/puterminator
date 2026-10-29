import { Shell } from "./shell";

export function SignIn({ configured }: { configured: boolean }) {
  return (
    <Shell>
      <div className="mx-auto grid w-full max-w-[680px] gap-4 px-5 pt-[18vh] text-center">
        <h1 className="text-balance font-medium text-xl tracking-tight">What should I do with your put.io?</h1>
        <p className="-mt-2 text-muted-foreground">
          I read your files, score the library and answer questions about it. This version changes nothing.
        </p>
        {configured ? (
          <a
            className="mx-auto mt-2 inline-flex h-[30px] items-center rounded-lg bg-primary px-3 font-medium text-primary-foreground transition-[background-color,transform] hover:bg-primary/85 active:scale-[0.96]"
            href="/auth/login"
          >
            Sign in with put.io
          </a>
        ) : (
          <div className="mx-auto mt-2 grid gap-1">
            <span className="mx-auto inline-flex h-[30px] items-center rounded-lg bg-secondary px-3 font-medium text-faint-foreground">
              Sign in with put.io
            </span>
            <span className="text-[12.5px] text-muted-foreground">Sign-in isn't configured yet. Check back soon.</span>
          </div>
        )}
      </div>
    </Shell>
  );
}
