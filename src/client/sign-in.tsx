import { Shell } from "./shell";

export function SignIn() {
  return (
    <Shell>
      <div className="mx-auto grid w-full max-w-[680px] gap-4 px-5 pt-[18vh] text-center">
        <h1 className="text-balance font-medium text-xl tracking-tight">What should I do with your put.io?</h1>
        <p className="-mt-2 text-muted-foreground">
          I read your files, score the library and answer questions about it. This version changes nothing.
        </p>
        <a
          className="mx-auto mt-2 inline-flex h-[30px] items-center rounded-lg bg-primary px-3 font-medium text-primary-foreground transition-[background-color,transform] hover:bg-primary/85 active:scale-[0.96]"
          href="/auth/login"
        >
          Sign in with put.io
        </a>
      </div>
    </Shell>
  );
}
