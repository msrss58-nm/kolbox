import { useNavigate } from "react-router";
import { Download } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/Button";
import { ROUTES } from "../../constants/routes";
import { IMPORT_TEXT } from "./import.constants";
import { MappingStep } from "./MappingStep";
import { StepIndicator } from "./StepIndicator";
import { SummaryStep } from "./SummaryStep";
import { useImportWizard } from "./useImportWizard";
import { UploadStep } from "./UploadStep";

export function ImportPage() {
  const navigate = useNavigate();
  const wizard = useImportWizard();

  const handleLoadDemo = async () => {
    const ok = await wizard.loadDemo();
    if (ok) void navigate(ROUTES.dashboard);
  };

  return (
    <>
      <PageHeader
        title={IMPORT_TEXT.title}
        subtitle={IMPORT_TEXT.subtitle}
        actions={
          <Button
            variant="secondary"
            onClick={() => void wizard.exportRegistry()}
            loading={wizard.busy}
          >
            <Download className="size-4" />
            {IMPORT_TEXT.exportButton}
          </Button>
        }
      />

      <StepIndicator current={wizard.step} />

      {wizard.step === "upload" && (
        <UploadStep
          onFileSelected={(file) => void wizard.loadFile(file)}
          onLoadDemo={() => void handleLoadDemo()}
          busy={wizard.busy}
        />
      )}

      {wizard.step === "map" && wizard.sheet && (
        <MappingStep
          sheet={wizard.sheet}
          fileName={wizard.fileName}
          mapping={wizard.mapping}
          onFieldMappingChange={wizard.setFieldMapping}
          preview={wizard.preview}
          requiredMapped={wizard.requiredMapped}
          busy={wizard.busy}
          onCommit={() => void wizard.commit()}
          onBack={wizard.reset}
        />
      )}

      {wizard.step === "done" && wizard.summary && (
        <SummaryStep summary={wizard.summary} onImportAnother={wizard.reset} />
      )}
    </>
  );
}
