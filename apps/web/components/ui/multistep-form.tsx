"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  APPLICATION_QUESTIONS,
  DEPARTMENTS,
  type Department,
} from "@/lib/internship-copy";
import { cn } from "@/lib/utils";

const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const MONO = "var(--font-geist-mono), monospace";
const GEIST = "var(--font-geist-sans), sans-serif";

const steps = [
  { id: "personal", title: "About you" },
  { id: "role", title: "Role fit" },
  { id: "answers", title: "Your answers" },
];

interface FormData {
  fullName: string;
  email: string;
  schoolYear: string;
  department: Department | "";
  availability: string;
  answers: Record<string, string>;
}

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3 } },
};

const contentVariants = {
  hidden: { opacity: 0, x: 50 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.3 } },
  exit: { opacity: 0, x: -50, transition: { duration: 0.2 } },
};

export default function MultistepForm() {
  const [currentStep, setCurrentStep] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>({
    fullName: "",
    email: "",
    schoolYear: "",
    department: "",
    availability: "",
    answers: {},
  });

  const updateField = <K extends keyof FormData>(field: K, value: FormData[K]) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const updateAnswer = (id: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      answers: { ...prev.answers, [id]: value },
    }));
  };

  const nextStep = () => {
    if (currentStep < steps.length - 1) setCurrentStep((prev) => prev + 1);
  };

  const prevStep = () => {
    if (currentStep > 0) setCurrentStep((prev) => prev - 1);
  };

  const isStepValid = () => {
    switch (currentStep) {
      case 0:
        return (
          formData.fullName.trim().length >= 2 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim()) &&
          formData.schoolYear.trim() !== ""
        );
      case 1:
        return formData.department !== "" && formData.availability.trim() !== "";
      case 2:
        return APPLICATION_QUESTIONS.every(
          (q) => (formData.answers[q.id] ?? "").trim().length > 0,
        );
      default:
        return true;
    }
  };

  async function handleSubmit() {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: formData.fullName.trim(),
          email: formData.email.trim(),
          schoolYear: formData.schoolYear.trim(),
          department: formData.department,
          availability: formData.availability.trim(),
          answers: formData.answers,
        }),
      });
      const data = (await res.json()) as { error?: string; portalUrl?: string };
      if (!res.ok) throw new Error(data.error ?? "Submit failed.");
      setPortalUrl(data.portalUrl ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (portalUrl) {
    return (
      <div className="shadcn-light w-full min-w-0 rounded-2xl border border-black/10 bg-white p-5 sm:p-8">
        <p
          className="text-[13px] uppercase tracking-[0.12em] text-[#9a9a9a]"
          style={{ fontFamily: MONO }}
        >
          Application received
        </p>
        <h2
          className="mt-3 text-[24px] leading-[30px] text-[#1d1b1b] sm:text-[28px] sm:leading-[34px]"
          style={{ fontFamily: SERIF, fontWeight: 400 }}
        >
          You&rsquo;re in the funnel.
        </h2>
        <p
          className="mt-4 text-[15px] leading-relaxed text-[#4b4b48]"
          style={{ fontFamily: GEIST }}
        >
          Save this personal portal link — Stage 2 and Stage 3 happen here. We
          also emailed it to you.
        </p>
        <a
          href={portalUrl}
          className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-lg bg-[#1c1917] px-5 text-[13px] text-[#e7e7e7] sm:w-auto"
        >
          Open your portal
        </a>
      </div>
    );
  }

  return (
    <div className="shadcn-light w-full min-w-0 max-w-lg">
      <motion.div
        className="mb-6 sm:mb-8"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="mb-2 flex justify-between">
          {steps.map((step, index) => (
            <motion.div
              key={step.id}
              className="flex flex-col items-center"
              whileHover={{ scale: 1.05 }}
            >
              <motion.button
                type="button"
                aria-label={`Go to step ${index + 1}: ${step.title}`}
                className={cn(
                  "h-3 w-3 rounded-full transition-colors duration-300 sm:h-4 sm:w-4",
                  index < currentStep
                    ? "bg-primary"
                    : index === currentStep
                      ? "bg-primary ring-4 ring-primary/20"
                      : "bg-muted",
                )}
                onClick={() => {
                  if (index <= currentStep) setCurrentStep(index);
                }}
                whileTap={{ scale: 0.95 }}
              />
              <motion.span
                className={cn(
                  "mt-1.5 hidden text-[10px] sm:block sm:text-xs",
                  index === currentStep
                    ? "font-medium text-primary"
                    : "text-muted-foreground",
                )}
                style={{ fontFamily: MONO }}
              >
                {step.title}
              </motion.span>
            </motion.div>
          ))}
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <motion.div
            className="h-full bg-primary"
            initial={{ width: 0 }}
            animate={{
              width: `${(currentStep / (steps.length - 1)) * 100}%`,
            }}
            transition={{ duration: 0.3 }}
          />
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1 }}
      >
        <Card className="overflow-hidden rounded-2xl border-black/10 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.08)]">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStep}
              initial="hidden"
              animate="visible"
              exit="exit"
              variants={contentVariants}
            >
              {currentStep === 0 && (
                <>
                  <CardHeader>
                    <CardTitle
                      className="text-[22px] font-normal sm:text-2xl"
                      style={{ fontFamily: SERIF }}
                    >
                      Tell us about yourself
                    </CardTitle>
                    <CardDescription style={{ fontFamily: GEIST }}>
                      Name, email, and where you are in school.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <motion.div variants={fadeInUp} className="space-y-2">
                      <Label htmlFor="fullName" style={{ fontFamily: MONO }}>
                        Full name
                      </Label>
                      <Input
                        id="fullName"
                        placeholder="Jane Doe"
                        value={formData.fullName}
                        onChange={(e) => updateField("fullName", e.target.value)}
                        className="border-black/10 bg-[#fbfbf9]"
                      />
                    </motion.div>
                    <motion.div variants={fadeInUp} className="space-y-2">
                      <Label htmlFor="email" style={{ fontFamily: MONO }}>
                        Email
                      </Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="you@school.edu"
                        value={formData.email}
                        onChange={(e) => updateField("email", e.target.value)}
                        className="border-black/10 bg-[#fbfbf9]"
                      />
                    </motion.div>
                    <motion.div variants={fadeInUp} className="space-y-2">
                      <Label htmlFor="schoolYear" style={{ fontFamily: MONO }}>
                        School year / class
                      </Label>
                      <Input
                        id="schoolYear"
                        placeholder="e.g. Junior, Class of 2028"
                        value={formData.schoolYear}
                        onChange={(e) => updateField("schoolYear", e.target.value)}
                        className="border-black/10 bg-[#fbfbf9]"
                      />
                    </motion.div>
                  </CardContent>
                </>
              )}

              {currentStep === 1 && (
                <>
                  <CardHeader>
                    <CardTitle
                      className="text-[22px] font-normal sm:text-2xl"
                      style={{ fontFamily: SERIF }}
                    >
                      Which seat are you applying for?
                    </CardTitle>
                    <CardDescription style={{ fontFamily: GEIST }}>
                      Pick a department and share your availability.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <motion.div variants={fadeInUp} className="space-y-2">
                      <Label style={{ fontFamily: MONO }}>Department</Label>
                      <RadioGroup
                        value={formData.department}
                        onValueChange={(value) =>
                          updateField("department", value as Department)
                        }
                        className="space-y-2"
                      >
                        {DEPARTMENTS.map((dept, index) => (
                          <motion.div
                            key={dept.key}
                            className="flex cursor-pointer items-center space-x-2 rounded-lg border border-black/10 p-3 transition-colors hover:bg-accent"
                            whileHover={{ scale: 1.01 }}
                            whileTap={{ scale: 0.99 }}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{
                              opacity: 1,
                              x: 0,
                              transition: { delay: 0.08 * index, duration: 0.3 },
                            }}
                          >
                            <RadioGroupItem value={dept.key} id={`dept-${dept.key}`} />
                            <Label
                              htmlFor={`dept-${dept.key}`}
                              className="w-full cursor-pointer font-normal"
                              style={{ fontFamily: GEIST }}
                            >
                              {dept.label}
                            </Label>
                          </motion.div>
                        ))}
                      </RadioGroup>
                    </motion.div>
                    <motion.div variants={fadeInUp} className="space-y-2">
                      <Label htmlFor="availability" style={{ fontFamily: MONO }}>
                        Availability
                      </Label>
                      <Input
                        id="availability"
                        placeholder="Hours/week and timezone"
                        value={formData.availability}
                        onChange={(e) => updateField("availability", e.target.value)}
                        className="border-black/10 bg-[#fbfbf9]"
                      />
                    </motion.div>
                  </CardContent>
                </>
              )}

              {currentStep === 2 && (
                <>
                  <CardHeader>
                    <CardTitle
                      className="text-[22px] font-normal sm:text-2xl"
                      style={{ fontFamily: SERIF }}
                    >
                      A few written answers
                    </CardTitle>
                    <CardDescription style={{ fontFamily: GEIST }}>
                      Short responses — be concrete.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {APPLICATION_QUESTIONS.map((q, index) => (
                      <motion.div
                        key={q.id}
                        variants={fadeInUp}
                        className="space-y-2"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{
                          opacity: 1,
                          y: 0,
                          transition: { delay: 0.08 * index, duration: 0.3 },
                        }}
                      >
                        <Label htmlFor={q.id} style={{ fontFamily: MONO }}>
                          {q.label}
                        </Label>
                        <Textarea
                          id={q.id}
                          placeholder={q.placeholder}
                          maxLength={q.maxLength}
                          value={formData.answers[q.id] ?? ""}
                          onChange={(e) => updateAnswer(q.id, e.target.value)}
                          className="min-h-[88px] border-black/10 bg-[#fbfbf9]"
                        />
                      </motion.div>
                    ))}
                  </CardContent>
                </>
              )}
            </motion.div>
          </AnimatePresence>

          {error ? (
            <p className="px-6 pb-2 text-[13px] text-red-700" style={{ fontFamily: GEIST }}>
              {error}
            </p>
          ) : null}

          <CardFooter className="flex justify-between pb-6 pt-4">
            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
              <Button
                type="button"
                variant="outline"
                onClick={prevStep}
                disabled={currentStep === 0}
                className="flex items-center gap-1 rounded-xl border-black/10"
              >
                <ChevronLeft className="h-4 w-4" /> Back
              </Button>
            </motion.div>
            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
              <Button
                type="button"
                onClick={
                  currentStep === steps.length - 1
                    ? () => void handleSubmit()
                    : nextStep
                }
                disabled={!isStepValid() || isSubmitting}
                className="flex items-center gap-1 rounded-xl bg-[#1c1917] text-[#e7e7e7] hover:bg-[#1c1917]/90"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Submitting…
                  </>
                ) : (
                  <>
                    {currentStep === steps.length - 1 ? "Submit" : "Next"}
                    {currentStep === steps.length - 1 ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </>
                )}
              </Button>
            </motion.div>
          </CardFooter>
        </Card>
      </motion.div>

      <motion.p
        className="mt-4 text-center text-[12px] leading-relaxed text-muted-foreground"
        style={{ fontFamily: GEIST }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.3 }}
      >
        Step {currentStep + 1} of {steps.length}: {steps[currentStep].title}. We
        only collect what we need to evaluate your application.
      </motion.p>
    </div>
  );
}
