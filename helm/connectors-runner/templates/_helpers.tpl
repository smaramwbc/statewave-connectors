{{/*
Common name + label helpers shared across templates.
Standard Helm convention — keeps template files focused on the resource
shape rather than naming.
*/}}

{{- define "connectors-runner.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "connectors-runner.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "connectors-runner.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "connectors-runner.labels" -}}
helm.sh/chart: {{ include "connectors-runner.chart" . }}
{{ include "connectors-runner.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "connectors-runner.selectorLabels" -}}
app.kubernetes.io/name: {{ include "connectors-runner.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Resolve the secret name we mount as env. When `existingSecret` is set
the operator points us at an externally-managed Secret (External Secrets
Operator, Sealed Secrets, SOPS); otherwise we render one from the
inline `secrets` map.
*/}}
{{- define "connectors-runner.secretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "connectors-runner.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Resolve the image tag — defaults to the chart's appVersion when unset.
*/}}
{{- define "connectors-runner.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag -}}
{{- end -}}
